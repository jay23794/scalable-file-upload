import { JobState } from 'bullmq';
import { FileUploadOcrService } from './file-upload-ocr.service';
import { parsePipelineSummary } from '../../infra/queueEvents';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
 
const HEALTHY_STATES: ReadonlyArray<JobState | 'unknown'> = [
  'waiting',
  'active',
  'delayed',
  'waiting-children',
  'prioritized',
];

export interface SweepResult {
  scanned: number;
  healthy: number;
  reconciled: number;
  reenqueued: number;
}

export async function sweepStuckUploads(
  service: FileUploadOcrService,
  now: Date = new Date(),
): Promise<SweepResult> {
  const cutoff = new Date(now.getTime() - STUCK_THRESHOLD_MS);
  const candidates = await service.findStuck(cutoff);

  let healthy = 0;
  let reconciled = 0;
  let reenqueued = 0;

  for (const upload of candidates) {
    const state = await service.getJobState(upload.id);

    if (state && HEALTHY_STATES.includes(state)) {
      healthy++;
      continue;
    }

    if (state === 'completed') {
      const summary = parsePipelineSummary(await service.getJobReturnValue(upload.id));
      if (summary) {
        await service.markReadyWithSummary(upload.id, summary);
      } else {
        await service.markStatus(upload.id, 'ready');
      }
      reconciled++;
      continue;
    }

    if (state === 'failed') {
      await service.markStatus(upload.id, 'failed');
      reconciled++;
      continue;
    }

    await service.reenqueue(upload);
    reenqueued++;
  }

  return { scanned: candidates.length, healthy, reconciled, reenqueued };
}

export function startSweeper(service: FileUploadOcrService): NodeJS.Timeout {
  const tick = async () => {
    try {
      const result = await sweepStuckUploads(service);
      if (result.reconciled > 0 || result.reenqueued > 0) {
        console.log(
          `[sweeper] scanned=${result.scanned} healthy=${result.healthy} ` +
            `reconciled=${result.reconciled} reenqueued=${result.reenqueued}`,
        );
      }
    } catch (err) {
      console.error('[sweeper] tick failed', err);
    }
  };

  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref?.();
  void tick();
  return timer;
}

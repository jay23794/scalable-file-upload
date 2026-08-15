import { JobState } from 'bullmq';
import { FileUploadOcrService, QueueKey } from './file-upload-ocr.service';
import { parsePipelineSummary } from '../../infra/queueEvents';
import { UploadRecord } from './types';

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

function queueForStatus(record: UploadRecord): QueueKey {
  return record.status === 'ml_processing' ? 'embed' : 'ocr';
}

async function reconcileOcr(
  service: FileUploadOcrService,
  record: UploadRecord,
  state: JobState | 'unknown' | undefined,
): Promise<'healthy' | 'reconciled' | 'reenqueued'> {
  if (state && HEALTHY_STATES.includes(state)) return 'healthy';

  if (state === 'completed') {
    await service.markStatus(record.id, 'ml_processing');
    return 'reconciled';
  }

  if (state === 'failed') {
    await service.markStatus(record.id, 'failed');
    return 'reconciled';
  }

  await service.reenqueueOcr(record);
  return 'reenqueued';
}

async function reconcileEmbed(
  service: FileUploadOcrService,
  record: UploadRecord,
  state: JobState | 'unknown' | undefined,
): Promise<'healthy' | 'reconciled' | 'reenqueued'> {
  if (state && HEALTHY_STATES.includes(state)) return 'healthy';

  if (state === 'completed') {
    const summary = parsePipelineSummary(await service.getJobReturnValue(record.id, 'embed'));
    if (summary) {
      await service.markReadyWithSummary(record.id, summary);
    } else {
      await service.markStatus(record.id, 'ready');
    }
    return 'reconciled';
  }

  if (state === 'failed') {
    await service.markStatus(record.id, 'failed');
    return 'reconciled';
  }

  await service.reenqueueEmbed(record);
  return 'reenqueued';
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
    const queue = queueForStatus(upload);
    const state = await service.getJobState(upload.id, queue);

    const outcome =
      queue === 'ocr'
        ? await reconcileOcr(service, upload, state)
        : await reconcileEmbed(service, upload, state);

    if (outcome === 'healthy') healthy++;
    else if (outcome === 'reconciled') reconciled++;
    else reenqueued++;
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

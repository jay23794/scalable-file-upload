import { JobState } from 'bullmq';
import { FileUploadOcrService, QueueKey } from './file-upload-ocr.service';
import { parsePipelineSummary } from '../../infra/queueEvents';
import { UploadRecord } from './types';

// Sweeper is the *fallback* path for status reconciliation. QueueEvents is the
// fast push path; if the backend was down, restarted, or dropped its Redis
// subscription during a completion/failure event, Mongo will drift from the
// truth stored in Redis (BullMQ). This periodic pull recovers that.

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Only reconcile uploads stuck for >10 min. Below that, assume QueueEvents
// will (or did) handle it — avoids racing the push path on healthy jobs.
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;

// BullMQ states that mean "job is progressing normally" — leave Mongo alone.
// Notably excludes 'completed' / 'failed' / undefined, which are the states
// that require Mongo to catch up.
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

// Which queue owns this upload right now depends on how far the pipeline got.
// Anything past OCR (`ml_processing`) lives on embed-queue; earlier states
// (`pending`, `ocr_processing`) still belong to ocr-queue.
function queueForStatus(record: UploadRecord): QueueKey {
  return record.status === 'ml_processing' ? 'embed' : 'ocr';
}

async function reconcileOcr(
  service: FileUploadOcrService,
  record: UploadRecord,
  state: JobState | 'unknown' | undefined,
): Promise<'healthy' | 'reconciled' | 'reenqueued'> {
  if (state && HEALTHY_STATES.includes(state)) return 'healthy';

  // OCR finished but Mongo missed the event — promote to ml_processing,
  // NOT ready. Embedding still has to run on embed-queue before the upload
  // is user-visible-complete.
  if (state === 'completed') {
    await service.markStatus(record.id, 'ml_processing');
    return 'reconciled';
  }

  if (state === 'failed') {
    await service.markStatus(record.id, 'failed');
    return 'reconciled';
  }

  // state is undefined → job was pruned from Redis or never made it there.
  // Safest recovery is to re-enqueue with a fresh signed download URL.
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
    // Return value is persisted on the job's Redis hash — read it and, if
    // parseable, write the full PipelineSummary. Fall back to a bare `ready`
    // status if the job was pruned before we could read `returnvalue`.
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

  // Re-enqueue mints a fresh chunks download URL before pushing the job so
  // the ml worker doesn't retry with an already-expired URL.
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
    // BullMQ read-through to Redis — cheap and authoritative.
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
      // Silent when nothing changed — logs only when the sweeper actually
      // had to do work, so noisy healthy ticks don't drown out real drift.
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
  // Don't let the sweeper timer keep the process alive on its own — if the
  // HTTP server closes, we want to exit cleanly instead of waiting 5 min.
  timer.unref?.();
  // Kick off an immediate first tick so we don't wait a full interval after
  // boot to reconcile anything that was in-flight before the last restart.
  void tick();
  return timer;
}

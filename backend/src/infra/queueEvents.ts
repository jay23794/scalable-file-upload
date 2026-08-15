import { Queue, QueueEvents } from 'bullmq';
import { env } from '../config/env';
import { ocrQueue, redisConnection } from './queue';
import { embedQueue } from './embedQueue';
import { getIo } from './io';
import { fileUploadOcrService } from './container';
import { PipelineSummary } from '../features/file-upload-ocr/types';

let ocrQueueEvents: QueueEvents | undefined;
let embedQueueEvents: QueueEvents | undefined;

async function resolveUploadId(queue: Queue, jobId: string): Promise<string | undefined> {
  const job = await queue.getJob(jobId);
  return job?.data.uploadId;
}

export function parsePipelineSummary(raw: unknown): PipelineSummary | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.chunkCount !== 'number' ||
    typeof r.model !== 'string' ||
    typeof r.dim !== 'number' ||
    (typeof r.storedAt !== 'string' && !(r.storedAt instanceof Date))
  ) {
    return undefined;
  }
  return {
    chunkCount: r.chunkCount,
    model: r.model,
    dim: r.dim,
    storedAt: r.storedAt instanceof Date ? r.storedAt : new Date(r.storedAt),
  };
}

function wireOcrEvents(events: QueueEvents): void {
  events.on('active', async ({ jobId }) => {
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'ocr_processing');
  });

  events.on('completed', async ({ jobId }) => {
    console.log(`[queue-events:ocr] job ${jobId} completed`);
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'ml_processing');
    getIo().to(`upload:${uploadId}`).emit('ocr:progress', { step: 'embed', pct: 95 });
  });

  events.on('failed', async ({ jobId, failedReason }) => {
    console.error(`[queue-events:ocr] job ${jobId} failed: ${failedReason}`);
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'failed');
    getIo().to(`upload:${uploadId}`).emit('ocr:failed', { reason: failedReason });
  });

  events.on('progress', async ({ jobId, data }) => {
    const uploadId = await resolveUploadId(ocrQueue, jobId);
    if (!uploadId) return;
    getIo().to(`upload:${uploadId}`).emit('ocr:progress', data);
  });
}

function wireEmbedEvents(events: QueueEvents): void {
  events.on('active', async ({ jobId }) => {
    const uploadId = await resolveUploadId(embedQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'ml_processing');
  });

  events.on('completed', async ({ jobId, returnvalue }) => {
    console.log(`[queue-events:embed] job ${jobId} completed`, returnvalue);
    const uploadId = await resolveUploadId(embedQueue, jobId);
    if (!uploadId) return;
    const summary = parsePipelineSummary(returnvalue);
    if (summary) {
      await fileUploadOcrService.markReadyWithSummary(uploadId, summary);
    } else {
      console.warn(`[queue-events:embed] job ${jobId} completed with unparseable returnvalue; marking ready without summary`);
      await fileUploadOcrService.markStatus(uploadId, 'ready');
    }
    getIo().to(`upload:${uploadId}`).emit('ocr:completed', returnvalue);
  });

  events.on('failed', async ({ jobId, failedReason }) => {
    console.error(`[queue-events:embed] job ${jobId} failed: ${failedReason}`);
    const uploadId = await resolveUploadId(embedQueue, jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'failed');
    getIo().to(`upload:${uploadId}`).emit('ocr:failed', { reason: failedReason });
  });
}

export function startQueueEvents(): { ocr: QueueEvents; embed: QueueEvents } {
  if (!ocrQueueEvents) {
    ocrQueueEvents = new QueueEvents(env.ocrQueue.name, { connection: redisConnection });
    wireOcrEvents(ocrQueueEvents);
  }
  if (!embedQueueEvents) {
    embedQueueEvents = new QueueEvents(env.embedQueue.name, { connection: redisConnection });
    wireEmbedEvents(embedQueueEvents);
  }
  return { ocr: ocrQueueEvents, embed: embedQueueEvents };
}

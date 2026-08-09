import { QueueEvents } from 'bullmq';
import { env } from '../config/env';
import { ocrQueue, redisConnection } from './queue';
import { getIo } from './io';
import { fileUploadOcrService } from './container';
import { PipelineSummary } from '../features/file-upload-ocr/types';

let ocrQueueEvents: QueueEvents | undefined;

async function resolveUploadId(jobId: string): Promise<string | undefined> {
  const job = await ocrQueue.getJob(jobId);
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

export function startQueueEvents(): QueueEvents {
  if (ocrQueueEvents) return ocrQueueEvents;

  ocrQueueEvents = new QueueEvents(env.ocrQueue.name, {
    connection: redisConnection,
  });



  ocrQueueEvents.on('completed', async ({ jobId, returnvalue }) => {
    console.log(`[queue-events] job ${jobId} completed`, returnvalue);
    const uploadId = await resolveUploadId(jobId);
    if (!uploadId) return;

    const summary = parsePipelineSummary(returnvalue);
    if (summary) {
      await fileUploadOcrService.markReadyWithSummary(uploadId, summary);
    } else {
      console.warn(`[queue-events] job ${jobId} completed with unparseable returnvalue; marking ready without summary`);
      await fileUploadOcrService.markStatus(uploadId, 'ready');
    }
    getIo().to(`upload:${uploadId}`).emit('ocr:completed', returnvalue);
  });

  ocrQueueEvents.on('failed', async ({ jobId, failedReason }) => {
    console.error(`[queue-events] job ${jobId} failed: ${failedReason}`);
    const uploadId = await resolveUploadId(jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'failed');
    getIo().to(`upload:${uploadId}`).emit('ocr:failed', { reason: failedReason });
  });

  ocrQueueEvents.on('progress', async ({ jobId, data }) => {
    console.log(`[queue-events] job ${jobId} progress`, data);
    const uploadId = await resolveUploadId(jobId);
    if (!uploadId) return;
    getIo().to(`upload:${uploadId}`).emit('ocr:progress', data);
  });

  ocrQueueEvents.on('active', async ({ jobId }) => {
    console.log(`[queue-events] job ${jobId} active`);
    const uploadId = await resolveUploadId(jobId);
    if (!uploadId) return;
    await fileUploadOcrService.markStatus(uploadId, 'ocr_processing');
  });

  return ocrQueueEvents;
}

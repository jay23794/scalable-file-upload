import { QueueEvents } from 'bullmq';
import { env } from '../config/env';
import { ocrQueue, redisConnection } from './queue';
import { getIo } from './io';

let ocrQueueEvents: QueueEvents | undefined;

async function resolveUploadId(jobId: string): Promise<string | undefined> {
  const job = await ocrQueue.getJob(jobId);
  return job?.data.uploadId;
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
    getIo().to(`upload:${uploadId}`).emit('ocr:completed', returnvalue);
  });

  ocrQueueEvents.on('failed', async ({ jobId, failedReason }) => {
    console.error(`[queue-events] job ${jobId} failed: ${failedReason}`);
    const uploadId = await resolveUploadId(jobId);
    if (!uploadId) return;
    getIo().to(`upload:${uploadId}`).emit('ocr:failed', { reason: failedReason });
  });

  ocrQueueEvents.on('progress', async ({ jobId, data }) => {
    console.log(`[queue-events] job ${jobId} progress`, data);
    const uploadId = await resolveUploadId(jobId);
    if (!uploadId) return;
    getIo().to(`upload:${uploadId}`).emit('ocr:progress', data);
  });

  ocrQueueEvents.on('active', ({ jobId }) => {
    console.log(`[queue-events] job ${jobId} active`);
  });

  return ocrQueueEvents;
}

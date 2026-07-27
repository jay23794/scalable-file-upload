import { QueueEvents } from 'bullmq';
import { env } from '../config/env';
import { redisConnection } from './queue';

export const ocrQueueEvents = new QueueEvents(env.ocrQueue.name, {
  connection: redisConnection,
});

ocrQueueEvents.on('completed', ({ jobId, returnvalue }) => {
  console.log(`[queue-events] job ${jobId} completed`, returnvalue);
  // TODO: push to client via socket, e.g.
  // io.to(`upload:${uploadId}`).emit('ocr:completed', returnvalue);
});

ocrQueueEvents.on('failed', ({ jobId, failedReason }) => {
  console.error(`[queue-events] job ${jobId} failed: ${failedReason}`);
  // TODO: io.to(`upload:${uploadId}`).emit('ocr:failed', { reason: failedReason });
});

ocrQueueEvents.on('progress', ({ jobId, data }) => {
  console.log(`[queue-events] job ${jobId} progress`, data);
  // TODO: io.to(`upload:${uploadId}`).emit('ocr:progress', data);
});

ocrQueueEvents.on('active', ({ jobId }) => {
  console.log(`[queue-events] job ${jobId} active`);
});

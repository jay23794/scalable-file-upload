import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../config/env';

export interface OcrJobData {
  uploadId: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  downloadUrl: string;
}

export const redisConnection = new IORedis(env.redis.url, {
  maxRetriesPerRequest: null,
});

export const ocrQueue = new Queue<OcrJobData>(env.ocrQueue.name, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

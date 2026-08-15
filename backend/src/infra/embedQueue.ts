import { Queue } from 'bullmq';
import { redisConnection } from './queue';
import { env } from '../config/env';

export interface EmbedJobData {
  uploadId: string;
  chunksPath: string;
  chunksSignedUrl: string;
}

export const embedQueue = new Queue<EmbedJobData>(env.embedQueue.name, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

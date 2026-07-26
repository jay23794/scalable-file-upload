import { Worker } from 'bullmq';
import { env } from './config/env';
import { redisConnection } from './infra/redis';
import { runPipeline } from './handlers/process';
import { OcrJobData } from './pipeline/types';

export const ocrWorker = new Worker<OcrJobData>(
  env.ocrQueue.name,
  async (job) => {
    return runPipeline({
      jobId: job.id ?? job.name,
      uploadId: job.data.uploadId,
      storagePath: job.data.storagePath,
      filename: job.data.filename,
      mimeType: job.data.mimeType,
    });
  },
  {
    connection: redisConnection,
    concurrency: env.ocrQueue.concurrency,
  },
);

ocrWorker.on('completed', (job) => {
  console.log(`[worker] job ${job.id} completed`);
});

ocrWorker.on('failed', (job, err) => {
  console.error(`[worker] job ${job?.id} failed:`, err.message);
});

ocrWorker.on('error', (err) => {
  console.error('[worker] error:', err);
});

console.log(
  `[worker] listening on queue "${env.ocrQueue.name}" with concurrency ${env.ocrQueue.concurrency}`,
);

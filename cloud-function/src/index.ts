import express, { Request, Response } from 'express';
import { Worker } from 'bullmq';
import { env } from './config/env';
import { redisConnection } from './infra/redis';
import { runPipeline } from './handlers/process';
import { OcrJobData } from './pipeline/types';

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'cloud-function' });
});

app.listen(env.port, () => {
  console.log(`[cloud-function] http listening on http://localhost:${env.port}`);
});

export const ocrWorker = new Worker<OcrJobData>(
  env.ocrQueue.name,
  async (job) => {
    return runPipeline(
      {
        jobId: job.id ?? job.name,
        uploadId: job.data.uploadId,
        storagePath: job.data.storagePath,
        filename: job.data.filename,
        mimeType: job.data.mimeType,
        downloadUrl: job.data.downloadUrl,
      },
      (progress) => job.updateProgress(progress),
    );
  },
  {
    connection: redisConnection,
    concurrency: env.ocrQueue.concurrency,
  },
);

ocrWorker.on('completed', (job) => {
  console.log(`[cloud-function] job ${job.id} completed`);
});

ocrWorker.on('failed', (job, err) => {
  console.error(`[cloud-function] job ${job?.id} failed:`, err.message);
});

ocrWorker.on('error', (err) => {
  console.error('[cloud-function] worker error:', err);
});

console.log(
  `[cloud-function] worker listening on queue "${env.ocrQueue.name}" with concurrency ${env.ocrQueue.concurrency}`,
);

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[cloud-function] ${signal} received, draining in-flight jobs...`);
  try {
    await ocrWorker.close();
    await redisConnection.quit();
    console.log('[cloud-function] shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[cloud-function] shutdown error:', err);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

import { Worker, UnrecoverableError } from 'bullmq';
import { env } from './config/env';
import { redisConnection } from './infra/redis';
import { warmup } from './infra/embedder';
import { getVectorStore } from './infra/vectorstore';
import { readiness } from './infra/readiness';
import { runEmbedJob, EmbedJobData } from './features/embeddings/embed-job';

async function bootstrap(): Promise<void> {
  await Promise.all([
    warmup().then(() => {
      readiness.modelReady = true;
      console.log(`[worker] embedding model loaded: ${env.embedding.model}`);
    }),
    getVectorStore()
      .init()
      .then(() => {
        readiness.vectorStoreReady = true;
        console.log(`[worker] vector store ready: ${getVectorStore().name}`);
      }),
  ]);
}

export const embedWorker = new Worker<EmbedJobData>(
  env.embedQueue.name,
  async (job) => {
    try {
      return await runEmbedJob(job.data);
    } catch (err) {
      const e = err as Error & { permanent?: boolean };
      if (e.permanent) {
        throw new UnrecoverableError(e.message);
      }
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: env.embedQueue.concurrency,
    autorun: false,
  },
);

embedWorker.on('completed', (job) => {
  console.log(`[embed-worker] job ${job.id} completed`);
});

embedWorker.on('failed', (job, err) => {
  console.error(`[embed-worker] job ${job?.id} failed:`, err.message);
});

embedWorker.on('error', (err) => {
  console.error('[embed-worker] error:', err);
});

bootstrap()
  .then(() => {
    embedWorker.run();
    console.log(
      `[embed-worker] listening on "${env.embedQueue.name}" with concurrency ${env.embedQueue.concurrency}`,
    );
  })
  .catch((err) => {
    console.error('[embed-worker] bootstrap failed:', err);
    process.exit(1);
  });

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[embed-worker] ${signal} received, draining in-flight jobs...`);
  try {
    await embedWorker.close();
    await redisConnection.quit();
    console.log('[embed-worker] shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[embed-worker] shutdown error:', err);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

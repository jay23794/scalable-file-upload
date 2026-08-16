import express, { Request, Response } from 'express';
import { Worker, UnrecoverableError } from 'bullmq';
import { env } from './config/env';
import { redisConnection } from './infra/redis';
import { embeddingsRouter } from './features/embeddings/embeddings.routes';
import { warmup } from './infra/embedder';
import { readiness } from './infra/readiness';
import { getVectorStore } from './infra/vectorstore';
import { runEmbedJob, EmbedJobData } from './features/embeddings/embed-job';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    ok: readiness.modelReady && readiness.vectorStoreReady,
    service: 'ml',
    model: env.embedding.model,
    dim: env.embedding.dim,
    modelReady: readiness.modelReady,
    vectorStoreReady: readiness.vectorStoreReady,
    vectorStore: env.vectorStore.driver,
  });
});

app.get('/debug/sample', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 20);
    const store = getVectorStore();
    const rows = await store.sample(limit);
    res.json({ store: store.name, count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: 'sample failed', message: (err as Error).message });
  }
});

app.get('/debug/count', async (req: Request, res: Response) => {
  try {
    const uploadId = typeof req.query.upload_id === 'string' ? req.query.upload_id : undefined;
    const store = getVectorStore();
    const count = await store.count(uploadId);
    res.json({
      store: store.name,
      collection: env.vectorStore.driver === 'milvus' ? env.milvus.collection : env.supabase.table,
      uploadId: uploadId ?? null,
      count,
    });
  } catch (err) {
    res.status(500).json({ error: 'count failed', message: (err as Error).message });
  }
});

app.use('/', embeddingsRouter);

app.listen(env.port, () => {
  console.log(`[ml] http listening on http://localhost:${env.port}`);
});

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
  console.log(`[ml] embed job ${job.id} completed`);
});

embedWorker.on('failed', (job, err) => {
  console.error(`[ml] embed job ${job?.id} failed:`, err.message);
});

embedWorker.on('error', (err) => {
  console.error('[ml] embed worker error:', err);
});

Promise.all([
  warmup().then(() => {
    readiness.modelReady = true;
    console.log(`[ml] embedding model loaded: ${env.embedding.model}`);
  }),
  getVectorStore()
    .init()
    .then(() => {
      readiness.vectorStoreReady = true;
      console.log(`[ml] vector store ready: ${getVectorStore().name}`);
    }),
])
  .then(() => {
    embedWorker.run();
    console.log(
      `[ml] embed worker listening on "${env.embedQueue.name}" with concurrency ${env.embedQueue.concurrency}`,
    );
  })
  .catch((err) => {
    console.error('[ml] bootstrap failed:', err);
  });

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[ml] ${signal} received, draining in-flight jobs...`);
  try {
    await embedWorker.close();
    await redisConnection.quit();
    console.log('[ml] shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[ml] shutdown error:', err);
    process.exit(1);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

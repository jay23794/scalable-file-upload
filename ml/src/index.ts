import express, { Request, Response } from 'express';
import { env } from './config/env';
import { redisConnection } from './infra/redis';
import { embeddingsRouter } from './features/embeddings/embeddings.routes';
import { warmup } from './infra/embedder';
import { readiness } from './infra/readiness';
import { vectorStore } from './infra/vectorstore';
import { startEmbedWorker, stopEmbedWorker } from './features/embeddings/embeddings.worker';
import {
  startGenerateWorker,
  stopGenerateWorker,
} from './features/generation/generation.worker';

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
    vectorStore: vectorStore.name,
  });
});

app.get('/debug/sample', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit ?? 20);
    const rows = await vectorStore.sample(limit);
    res.json({ store: vectorStore.name, count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: 'sample failed', message: (err as Error).message });
  }
});

app.get('/debug/count', async (req: Request, res: Response) => {
  try {
    const uploadId = typeof req.query.upload_id === 'string' ? req.query.upload_id : undefined;
    const count = await vectorStore.count(uploadId);
    res.json({
      store: vectorStore.name,
      collection: env.supabase.table,
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

// Workers must not consume jobs until the model and vector store are ready —
// a generation that starts before the embedder is loaded would fail on its
// first call. Each feature's worker is constructed with autorun: false and
// started here, once.
Promise.all([
  warmup().then(() => {
    readiness.modelReady = true;
    console.log(`[ml] embedding model loaded: ${env.embedding.model}`);
  }),
  vectorStore.init().then(() => {
    readiness.vectorStoreReady = true;
    console.log(`[ml] vector store ready: ${vectorStore.name}`);
  }),
])
  .then(() => {
    startEmbedWorker();
    startGenerateWorker();
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
    await Promise.all([stopEmbedWorker(), stopGenerateWorker()]);
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

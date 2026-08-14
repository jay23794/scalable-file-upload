import express, { Request, Response } from 'express';
import { env } from './config/env';
import { embeddingsRouter } from './features/embeddings/embeddings.routes';
import { warmup } from './infra/embedder';
import { readiness } from './infra/readiness';
import { getVectorStore } from './infra/vectorstore';

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
    res.json({ store: store.name, collection: env.vectorStore.driver === 'milvus' ? env.milvus.collection : env.supabase.table, uploadId: uploadId ?? null, count });
  } catch (err) {
    res.status(500).json({ error: 'count failed', message: (err as Error).message });
  }
});

app.use('/', embeddingsRouter);

app.listen(env.port, () => {
  console.log(`ml service listening on http://localhost:${env.port}`);

  warmup()
    .then(() => {
      readiness.modelReady = true;
      console.log(`embedding model loaded: ${env.embedding.model}`);
    })
    .catch((err) => {
      console.error('embedding model failed to load:', err);
    });

  const store = getVectorStore();
  store
    .init()
    .then(() => {
      readiness.vectorStoreReady = true;
      console.log(`vector store ready: ${store.name}`);
    })
    .catch((err) => {
      console.error(`vector store init failed (${store.name}):`, err);
    });
});

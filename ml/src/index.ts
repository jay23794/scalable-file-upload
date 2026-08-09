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

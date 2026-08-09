import express, { Request, Response } from 'express';
import { env } from './config/env';
import { embeddingsRouter } from './features/embeddings/embeddings.routes';
import { warmup } from './infra/embedder';
import { ensureCollection } from './infra/milvus';
import { readiness } from './infra/readiness';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    ok: readiness.modelReady && readiness.milvusReady,
    service: 'ml',
    model: env.embedding.model,
    dim: env.embedding.dim,
    modelReady: readiness.modelReady,
    milvusReady: readiness.milvusReady,
    collection: env.milvus.collection,
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

  ensureCollection()
    .then(() => {
      readiness.milvusReady = true;
      console.log(`milvus collection ready: ${env.milvus.collection}`);
    })
    .catch((err) => {
      console.error('milvus init failed:', err);
    });
});

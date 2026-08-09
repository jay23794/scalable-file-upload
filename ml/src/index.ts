import express, { Request, Response } from 'express';
import { env } from './config/env';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/healthz', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    service: 'ml',
    model: env.embedding.model,
    dim: env.embedding.dim,
  });
});

app.listen(env.port, () => {
  console.log(`ml service listening on http://localhost:${env.port}`);
});

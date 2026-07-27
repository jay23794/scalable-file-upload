import express, { Request, Response } from 'express';
import { env } from './config/env';

const app = express();
app.use(express.json());

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'cloud-function' });
});

app.listen(env.port, () => {
  console.log(`Cloud function mock listening on http://localhost:${env.port}`);
});

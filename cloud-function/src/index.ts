import express, { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { env } from './config/env';
import { runPipeline } from './handlers/process';

const app = express();
app.use(express.json());

const processSchema = z.object({
  uploadId: z.string().min(1),
  storagePath: z.string().min(1),
  filename: z.string().min(1),
  mimeType: z.string().optional(),
});

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'cloud-function' });
});

app.post('/process', async (req: Request, res: Response) => {
  const parsed = processSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  }

  const jobId = randomUUID();
  res.status(202).json({ jobId, status: 'accepted' });

  runPipeline({ jobId, ...parsed.data }).catch((err) => {
    console.error(`[cloud-function] job ${jobId} failed`, err);
  });
});

app.listen(env.port, () => {
  console.log(`Cloud function mock listening on http://localhost:${env.port}`);
});

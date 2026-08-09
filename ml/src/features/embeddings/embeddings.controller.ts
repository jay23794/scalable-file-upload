import { Request, Response } from 'express';
import { embedRequestSchema } from './embeddings.schema';
import { embedAndStore } from './embeddings.service';

export async function embed(req: Request, res: Response): Promise<void> {
  const parsed = embedRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid request', details: parsed.error.issues });
    return;
  }

  try {
    const result = await embedAndStore(parsed.data);
    res.json(result);
  } catch (err) {
    console.error(`embed failed for uploadId=${parsed.data.uploadId}:`, err);
    res.status(500).json({ error: 'embed failed', message: (err as Error).message });
  }
}

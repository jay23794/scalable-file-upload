import { Request, Response } from 'express';
import { embedRequestSchema } from './embeddings.schema';
import { embeddingsService } from '../../infra/container';
import { successResponse } from '../../utils/apiResponse';

export async function embed(req: Request, res: Response): Promise<void> {
  const parsed = embedRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ success: false, errors: parsed.error.flatten() });
    return;
  }

  try {
    const data = await embeddingsService.embedAndStore(parsed.data);
    res.json(successResponse(data, 'Chunks embedded'));
  } catch (err) {
    console.error(`embed failed for uploadId=${parsed.data.uploadId}:`, err);
    res.status(500).json({ success: false, error: (err as Error).message });
  }
}

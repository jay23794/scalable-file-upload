import { Request, Response } from 'express';
import { InternalSignedUrlSchema } from './internal.schema';
import { internalService } from '../../infra/container';

export const signedUrl = async (req: Request, res: Response) => {
  const parsed = InternalSignedUrlSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }
  const { path, mode } = parsed.data;

  try {
    if (mode === 'upload') {
      const data = await internalService.mintUploadUrl(path);
      return res.json({ success: true, mode, data });
    }
    if (mode === 'download') {
      const data = await internalService.mintDownloadUrl(path);
      return res.json({ success: true, mode, data });
    }
    await internalService.deleteObject(path);
    return res.json({ success: true, mode, data: { ok: true } });
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

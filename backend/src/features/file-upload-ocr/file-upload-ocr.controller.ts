import { Request, Response } from 'express';
import { fileUploadOcrService } from '../../infra/container';
import { CompleteUploadSchema, PresignUploadSchema } from './file-upload-ocr.schema';
import { successResponse } from '../../utils/apiResponse';

export const presign = async (req: Request, res: Response) => {
  const parsed = PresignUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const data = await fileUploadOcrService.presignUpload(parsed.data);
    return res.status(201).json(successResponse(data, 'Signed upload URL created'));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const complete = async (req: Request, res: Response) => {
  const parsed = CompleteUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, errors: parsed.error.flatten() });
  }

  try {
    const record = await fileUploadOcrService.completeUpload(parsed.data);
    return res.status(201).json(successResponse(record, 'Upload registered'));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const list = async (_req: Request, res: Response) => {
  try {
    const records = await fileUploadOcrService.listUploads();
    return res.json(successResponse(records));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const getById = async (req: Request, res: Response) => {
  try {
    const record = await fileUploadOcrService.getUpload(req.params.id);
    if (!record) {
      return res.status(404).json({ success: false, error: 'Upload not found' });
    }
    return res.json(successResponse(record));
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

export const remove = async (req: Request, res: Response) => {
  try {
    const ok = await fileUploadOcrService.removeUpload(req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, error: 'Upload not found' });
    }
    return res.status(204).send();
  } catch (err) {
    return res.status(500).json({ success: false, error: (err as Error).message });
  }
};

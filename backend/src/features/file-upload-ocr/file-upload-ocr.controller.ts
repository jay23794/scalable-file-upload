import { Request, Response } from 'express';
import { fileUploadOcrService } from '../../infra/container';
import { FileUploadSchema } from './file-upload-ocr.schema';

export const upload = (req: Request, res: Response) => {
  const parsed = FileUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ errors: parsed.error.flatten() });
  }

  const record = fileUploadOcrService.registerUpload(parsed.data);
  return res.status(201).json(record);
};

export const list = (_req: Request, res: Response) => {
  res.json(fileUploadOcrService.listUploads());
};

export const getById = (req: Request, res: Response) => {
  const record = fileUploadOcrService.getUpload(req.params.id);
  if (!record) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  return res.json(record);
};

export const remove = (req: Request, res: Response) => {
  const ok = fileUploadOcrService.removeUpload(req.params.id);
  if (!ok) {
    return res.status(404).json({ error: 'Upload not found' });
  }
  return res.status(204).send();
};

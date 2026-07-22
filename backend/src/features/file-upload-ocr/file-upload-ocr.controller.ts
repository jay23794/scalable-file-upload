import { Request, Response } from 'express';
import { fileUploadOcrService } from '../../infra/container';

export const upload = (req: Request, res: Response) => {
  const { filename, size, mimeType } = req.body ?? {};

  if (!filename || typeof size !== 'number' || !mimeType) {
    return res.status(400).json({ error: 'filename, size, and mimeType are required' });
  }

  const record = fileUploadOcrService.registerUpload({ filename, size, mimeType });
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

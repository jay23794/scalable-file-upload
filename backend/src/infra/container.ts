import { FileUploadOcrRepository } from '../features/file-upload-ocr/file-upload-ocr.repository';
import { FileUploadOcrService } from '../features/file-upload-ocr/file-upload-ocr.service';
import { SupabaseStorageService } from './storage';
import { ocrQueue } from './queue';

const _fileUploadOcrRepository = new FileUploadOcrRepository();
const _storage = new SupabaseStorageService();

export const fileUploadOcrService = new FileUploadOcrService(
  _fileUploadOcrRepository,
  _storage,
  ocrQueue,
);

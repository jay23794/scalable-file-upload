import { FileUploadOcrRepository } from '../features/file-upload-ocr/file-upload-ocr.repository';
import { FileUploadOcrService } from '../features/file-upload-ocr/file-upload-ocr.service';

const _fileUploadOcrRepository = new FileUploadOcrRepository();

export const fileUploadOcrService = new FileUploadOcrService(_fileUploadOcrRepository);


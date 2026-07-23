import { randomUUID } from 'crypto';
import { FileUploadOcrRepository, UploadRecord } from './file-upload-ocr.repository';
import { FileUploadInput } from './file-upload-ocr.schema';

export class FileUploadOcrService {
  constructor(private _repo: FileUploadOcrRepository) {}

  registerUpload(input: FileUploadInput): UploadRecord {
    return this._repo.create({
      id: randomUUID(),
      filename: input.filename,
      size: input.size,
      mimeType: input.mimeType,
      createdAt: new Date(),
    });
  }

  getUpload(id: string): UploadRecord | undefined {
    return this._repo.findById(id);
  }

  listUploads(): UploadRecord[] {
    return this._repo.list();
  }

  removeUpload(id: string): boolean {
    return this._repo.delete(id);
  }
}

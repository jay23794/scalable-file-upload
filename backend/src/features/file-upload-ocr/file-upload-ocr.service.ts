import { randomUUID } from 'crypto';
import { Queue } from 'bullmq';
import { FileUploadOcrRepository, UploadRecord } from './file-upload-ocr.repository';
import { CompleteUploadInput, PresignUploadInput } from './file-upload-ocr.schema';
import { PresignedUpload, SupabaseStorageService } from '../../infra/storage';
import { OcrJobData } from '../../infra/queue';

const sanitizeFilename = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');

export interface UploadRecordWithDownload extends UploadRecord {
  downloadUrl: string;
}

export class FileUploadOcrService {
  constructor(
    private _repo: FileUploadOcrRepository,
    private _storage: SupabaseStorageService,
    private _ocrQueue: Queue<OcrJobData>,
  ) {}

  async presignUpload(input: PresignUploadInput): Promise<PresignedUpload> {
    const path = `${randomUUID()}/${sanitizeFilename(input.filename)}`;
    return this._storage.createPresignedUpload(path);
  }

  async completeUpload(input: CompleteUploadInput): Promise<UploadRecord> {
    const record = this._repo.create({
      id: randomUUID(),
      path: input.path,
      filename: input.filename,
      size: input.size,
      mimeType: input.mimeType,
      createdAt: new Date(),
    });

    await this._ocrQueue.add('process', {
      uploadId: record.id,
      storagePath: record.path,
      filename: record.filename,
      mimeType: record.mimeType,
    });

    return record;
  }

  async getUpload(id: string): Promise<UploadRecordWithDownload | undefined> {
    const record = this._repo.findById(id);
    if (!record) return undefined;
    const downloadUrl = await this._storage.createSignedDownloadUrl(record.path);
    return { ...record, downloadUrl };
  }

  listUploads(): UploadRecord[] {
    return this._repo.list();
  }

  async removeUpload(id: string): Promise<boolean> {
    const record = this._repo.findById(id);
    if (!record) return false;
    await this._storage.remove(record.path);
    return this._repo.delete(id);
  }
}

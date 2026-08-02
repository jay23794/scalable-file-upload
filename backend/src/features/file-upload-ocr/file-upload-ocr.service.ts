import { randomUUID } from 'crypto';
import { JobState, Queue } from 'bullmq';
import { FileUploadOcrRepository } from './file-upload-ocr.repository';
import { UploadRecord, UploadStatus } from './types';
import { CompleteUploadInput, PresignUploadInput } from './file-upload-ocr.schema';
import { PresignedUpload, SupabaseStorageService } from '../../infra/storage';
import { OcrJobData } from '../../infra/queue';

const sanitizeFilename = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');

const buildJobData = (record: UploadRecord, downloadUrl: string): OcrJobData => ({
  uploadId: record.id,
  storagePath: record.path,
  filename: record.filename,
  mimeType: record.mimeType,
  downloadUrl,
});

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
    const now = new Date();
    const record = await this._repo.create({
      id: randomUUID(),
      path: input.path,
      filename: input.filename,
      size: input.size,
      mimeType: input.mimeType,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });

    const downloadUrl = await this._storage.createSignedDownloadUrl(record.path);
    await this._ocrQueue.add('process', buildJobData(record, downloadUrl), {
      jobId: record.id,
    });

    return record;
  }

  async getUpload(id: string): Promise<UploadRecordWithDownload | undefined> {
    const record = await this._repo.findById(id);
    if (!record) return undefined;
    const downloadUrl = await this._storage.createSignedDownloadUrl(record.path);
    return { ...record, downloadUrl };
  }

  listUploads(): Promise<UploadRecord[]> {
    return this._repo.list();
  }

  async removeUpload(id: string): Promise<boolean> {
    const record = await this._repo.findById(id);
    if (!record) return false;
    await this._storage.remove(record.path);
    return this._repo.delete(id);
  }

  markStatus(id: string, status: UploadStatus): Promise<UploadRecord | undefined> {
    return this._repo.updateStatus(id, status);
  }

  async getStatus(id: string): Promise<UploadStatus | undefined> {
    return (await this._repo.findById(id))?.status;
  }

  findStuck(olderThan: Date): Promise<UploadRecord[]> {
    return this._repo.findStuck(olderThan);
  }

  async reenqueue(record: UploadRecord): Promise<void> {
    const downloadUrl = await this._storage.createSignedDownloadUrl(record.path);
    await this._ocrQueue.add('process', buildJobData(record, downloadUrl), {
      jobId: record.id,
    });
  }

  async getJobState(id: string): Promise<JobState | 'unknown' | undefined> {
    const job = await this._ocrQueue.getJob(id);
    if (!job) return undefined;
    return job.getState();
  }
}

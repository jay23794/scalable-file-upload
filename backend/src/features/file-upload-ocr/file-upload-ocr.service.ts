import { randomUUID } from 'crypto';
import { JobState, Queue } from 'bullmq';
import { env } from '../../config/env';
import { FileUploadOcrRepository } from './file-upload-ocr.repository';
import { PipelineSummary, UploadRecord, UploadStatus } from './types';
import { CompleteUploadInput, PresignUploadInput } from './file-upload-ocr.schema';
import { PresignedUpload, SupabaseStorageService } from '../../infra/storage';
import { OcrJobData } from '../../infra/queue';
import { EmbedJobData } from '../../infra/embedQueue';

const sanitizeFilename = (name: string): string =>
  name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');

const buildJobData = (record: UploadRecord, downloadUrl: string): OcrJobData => ({
  uploadId: record.id,
  storagePath: record.path,
  filename: record.filename,
  mimeType: record.mimeType,
  downloadUrl,
});

const chunksPathFor = (uploadId: string): string => `chunks/${uploadId}.json`;

export interface UploadRecordWithDownload extends UploadRecord {
  downloadUrl: string;
}

export type QueueKey = 'ocr' | 'embed';

export class FileUploadOcrService {
  constructor(
    private _repo: FileUploadOcrRepository,
    private _storage: SupabaseStorageService,
    private _ocrQueue: Queue<OcrJobData>,
    private _embedQueue: Queue<EmbedJobData>,
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

  markReadyWithSummary(
    id: string,
    summary: PipelineSummary,
  ): Promise<UploadRecord | undefined> {
    return this._repo.markReadyWithSummary(id, summary);
  }

  async getStatus(id: string): Promise<UploadStatus | undefined> {
    return (await this._repo.findById(id))?.status;
  }

  findStuck(olderThan: Date): Promise<UploadRecord[]> {
    return this._repo.findStuck(olderThan);
  }

  async reenqueueOcr(record: UploadRecord): Promise<void> {
    const downloadUrl = await this._storage.createSignedDownloadUrl(record.path);
    await this._ocrQueue.add('process', buildJobData(record, downloadUrl), {
      jobId: record.id,
    });
  }

  async reenqueueEmbed(record: UploadRecord): Promise<void> {
    const chunksPath = chunksPathFor(record.id);
    const chunksSignedUrl = await this._storage.createSignedDownloadUrl(
      chunksPath,
      env.signedUrl.chunksDownloadTtlSeconds,
    );
    const data: EmbedJobData = {
      uploadId: record.id,
      chunksPath,
      chunksSignedUrl,
    };
    await this._embedQueue.add('embed', data, { jobId: record.id });
  }

  private _queueFor(key: QueueKey): Queue<OcrJobData> | Queue<EmbedJobData> {
    return key === 'ocr' ? this._ocrQueue : this._embedQueue;
  }

  async getJobState(id: string, queue: QueueKey): Promise<JobState | 'unknown' | undefined> {
    const job = await this._queueFor(queue).getJob(id);
    if (!job) return undefined;
    return job.getState();
  }

  async getJobReturnValue(id: string, queue: QueueKey): Promise<unknown | undefined> {
    const job = await this._queueFor(queue).getJob(id);
    return job?.returnvalue;
  }
}

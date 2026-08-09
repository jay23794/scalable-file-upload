export type UploadStatus =
  | 'pending'
  | 'ocr_processing'
  | 'ml_processing'
  | 'ready'
  | 'failed';

export interface PipelineSummary {
  chunkCount: number;
  model: string;
  dim: number;
  storedAt: Date;
}

export interface UploadRecord {
  id: string;
  path: string;
  filename: string;
  size: number;
  mimeType: string;
  status: UploadStatus;
  createdAt: Date;
  updatedAt: Date;
  pipelineSummary?: PipelineSummary;
}

export const IN_FLIGHT_STATUSES: UploadStatus[] = [
  'pending',
  'ocr_processing',
  'ml_processing',
];

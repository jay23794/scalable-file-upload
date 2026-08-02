export type UploadStatus =
  | 'pending'
  | 'ocr_processing'
  | 'ml_processing'
  | 'ready'
  | 'failed';

export interface UploadRecord {
  id: string;
  path: string;
  filename: string;
  size: number;
  mimeType: string;
  status: UploadStatus;
  createdAt: Date;
  updatedAt: Date;
}

export const IN_FLIGHT_STATUSES: UploadStatus[] = [
  'pending',
  'ocr_processing',
  'ml_processing',
];

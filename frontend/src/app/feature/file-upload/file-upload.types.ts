export type UploadStatus =
  | 'pending'
  | 'uploading'
  | 'processing'
  | 'completed'
  | 'error';

export type PipelineStep =
  | 'download'
  | 'detect'
  | 'ocr'
  | 'clean'
  | 'chunk'
  | 'ml'
  | 'store';

export interface UploadItem {
  clientId: string;
  file: File;
  progress: number;
  status: UploadStatus;
  error?: string;
  recordId?: string;
  pipelineStep?: PipelineStep;
  pipelinePct?: number;
}

export interface PresignRequest {
  filename: string;
  size: number;
  mimeType: string;
}

export interface PresignResponse {
  uploadUrl: string;
  token: string;
  path: string;
  bucket: string;
}

export interface CompleteRequest {
  path: string;
  filename: string;
  size: number;
  mimeType: string;
}

export interface UploadRecord {
  id: string;
  path: string;
  filename: string;
  size: number;
  mimeType: string;
  createdAt: string;
  downloadUrl?: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  message?: string;
  data: T;
}

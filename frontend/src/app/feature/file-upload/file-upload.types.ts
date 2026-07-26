export type UploadStatus = 'pending' | 'uploading' | 'completed' | 'error';

export interface UploadItem {
  clientId: string;
  file: File;
  progress: number;
  status: UploadStatus;
  error?: string;
  recordId?: string;
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

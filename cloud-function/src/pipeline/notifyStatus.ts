import { env } from '../config/env';

export type JobStatus = 'processing' | 'completed' | 'failed';

export interface StatusPayload {
  jobId: string;
  uploadId: string;
  status: JobStatus;
  message?: string;
  data?: unknown;
}

export async function notifyStatus(payload: StatusPayload): Promise<void> {
  const url = `${env.backendBaseUrl}/api/v1/file-upload-ocr/status`;
  console.log(`[cloud-function] notifyStatus -> ${url}`, payload);
}

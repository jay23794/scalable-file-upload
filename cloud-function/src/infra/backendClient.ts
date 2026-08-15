import { env } from '../config/env';

type Mode = 'upload' | 'download' | 'delete';

interface UploadUrlData {
  url: string;
  token: string;
  path: string;
}

interface DownloadUrlData {
  url: string;
  expiresAt: number;
}

interface DeleteData {
  ok: true;
}

interface SignedUrlResponse<T> {
  success: boolean;
  mode: Mode;
  data: T;
  error?: string;
}

async function postSignedUrl<T>(path: string, mode: Mode): Promise<T> {
  const res = await fetch(`${env.backendBaseUrl}/internal/signed-url`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.internalServiceToken}`,
    },
    body: JSON.stringify({ path, mode }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`backend /internal/signed-url ${mode} failed: ${res.status} ${body}`);
  }

  const json = (await res.json()) as SignedUrlResponse<T>;
  if (!json.success) {
    throw new Error(`backend /internal/signed-url ${mode} failed: ${json.error ?? 'unknown'}`);
  }
  return json.data;
}

export const mintChunksUploadUrl = (path: string) => postSignedUrl<UploadUrlData>(path, 'upload');
export const mintChunksDownloadUrl = (path: string) => postSignedUrl<DownloadUrlData>(path, 'download');
export const deleteChunks = (path: string) => postSignedUrl<DeleteData>(path, 'delete');

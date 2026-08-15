import { SupabaseStorageService } from '../../infra/storage';
import { env } from '../../config/env';

export interface UploadUrlResponse {
  url: string;
  token: string;
  path: string;
}

export interface DownloadUrlResponse {
  url: string;
  expiresAt: number;
}

export class InternalService {
  constructor(private _storage: SupabaseStorageService) {}

  async mintUploadUrl(path: string): Promise<UploadUrlResponse> {
    const p = await this._storage.createPresignedUpload(path);
    return { url: p.uploadUrl, token: p.token, path: p.path };
  }

  async mintDownloadUrl(path: string): Promise<DownloadUrlResponse> {
    const ttl = env.signedUrl.chunksDownloadTtlSeconds;
    const url = await this._storage.createSignedDownloadUrl(path, ttl);
    return { url, expiresAt: Date.now() + ttl * 1000 };
  }

  async deleteObject(path: string): Promise<void> {
    await this._storage.remove(path);
  }
}

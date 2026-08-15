import { supabase } from './supabase';
import { env } from '../config/env';

export interface PresignedUpload {
  uploadUrl: string;
  token: string;
  path: string;
  bucket: string;
}

export class SupabaseStorageService {
  constructor(private _bucket: string = env.supabase.bucket) {}

  async createPresignedUpload(path: string): Promise<PresignedUpload> {
    const { data, error } = await supabase.storage
      .from(this._bucket)
      .createSignedUploadUrl(path);

    if (error || !data) {
      throw new Error(`Failed to create signed upload URL: ${error?.message ?? 'unknown error'}`);
    }

    return {
      uploadUrl: data.signedUrl,
      token: data.token,
      path: data.path,
      bucket: this._bucket,
    };
  }

  async createSignedDownloadUrl(path: string, ttlSeconds?: number): Promise<string> {
    const ttl = ttlSeconds ?? env.signedUrl.downloadTtlSeconds;
    const { data, error } = await supabase.storage
      .from(this._bucket)
      .createSignedUrl(path, ttl);

    if (error || !data) {
      throw new Error(`Failed to create signed download URL: ${error?.message ?? 'unknown error'}`);
    }

    return data.signedUrl;
  }

  async remove(path: string): Promise<void> {
    const { error } = await supabase.storage.from(this._bucket).remove([path]);
    if (error) {
      throw new Error(`Failed to remove object: ${error.message}`);
    }
  }
}

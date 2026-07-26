import { PipelineContext } from './types';

export interface StoredMetadata {
  uploadId: string;
  filename: string;
  mimeType: string;
  chunkCount: number;
  model: string;
  storedAt: string;
}

export async function storeMetadata(ctx: PipelineContext): Promise<StoredMetadata> {
  const meta: StoredMetadata = {
    uploadId: ctx.job.uploadId,
    filename: ctx.job.filename,
    mimeType: ctx.type?.mimeType ?? 'application/octet-stream',
    chunkCount: ctx.chunks?.length ?? 0,
    model: ctx.ml?.model ?? 'unknown',
    storedAt: new Date().toISOString(),
  };

  console.log('[cloud-function] storeMetadata', meta);
  return meta;
}

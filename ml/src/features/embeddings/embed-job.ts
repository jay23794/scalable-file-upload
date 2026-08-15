import { z } from 'zod';
import { embedAndStore } from './embeddings.service';
import { mintChunksDownloadUrl, deleteChunks } from '../../infra/backendClient';
import { classifyStorageError } from '../../infra/supabaseErrors';

export interface EmbedJobData {
  uploadId: string;
  chunksPath: string;
  chunksSignedUrl: string;
}

export interface EmbedJobResult {
  uploadId: string;
  chunkCount: number;
  dim: number;
  model: string;
  storedAt: string;
}

const chunksPayloadSchema = z.object({
  uploadId: z.string().min(1),
  chunks: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        text: z.string().min(1),
      }),
    )
    .min(1),
});

async function downloadChunks(url: string): Promise<Response> {
  return fetch(url);
}

async function fetchChunksWithRefresh(data: EmbedJobData): Promise<unknown> {
  let res = await downloadChunks(data.chunksSignedUrl);

  if (!res.ok) {
    const cls = await classifyStorageError(res);

    if (cls.kind === 'expired') {
      console.warn(
        `[embed-job] signed URL expired for uploadId=${data.uploadId}, re-minting via backend`,
      );
      const fresh = await mintChunksDownloadUrl(data.chunksPath);
      res = await downloadChunks(fresh.url);
      if (!res.ok) {
        const retryCls = await classifyStorageError(res);
        throw new Error(
          `chunks download failed after re-mint: ${retryCls.status} ${retryCls.body}`,
        );
      }
    } else if (cls.kind === 'not-found') {
      const err = new Error(`CHUNKS_MISSING: ${data.chunksPath}`);
      (err as Error & { permanent?: boolean }).permanent = true;
      throw err;
    } else {
      throw new Error(`chunks download failed: ${cls.kind} ${cls.status} ${cls.body}`);
    }
  }

  return res.json();
}

export async function runEmbedJob(data: EmbedJobData): Promise<EmbedJobResult> {
  const raw = await fetchChunksWithRefresh(data);

  const parsed = chunksPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    const err = new Error(`INVALID_INPUT: chunks payload malformed: ${parsed.error.message}`);
    (err as Error & { permanent?: boolean }).permanent = true;
    throw err;
  }

  const { chunks } = parsed.data;
  const result = await embedAndStore({ uploadId: data.uploadId, chunks });

  try {
    await deleteChunks(data.chunksPath);
  } catch (err) {
    console.warn(
      `[embed-job] failed to delete chunks for uploadId=${data.uploadId}:`,
      (err as Error).message,
    );
  }

  return {
    uploadId: result.uploadId,
    chunkCount: result.chunkCount,
    dim: result.dim,
    model: result.model,
    storedAt: new Date().toISOString(),
  };
}

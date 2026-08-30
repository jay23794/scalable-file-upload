import { z } from 'zod';
import { Worker, UnrecoverableError } from 'bullmq';
import { env } from '../../config/env';
import { redisConnection } from '../../infra/redis';
import { embeddingsService } from '../../infra/container';
import { mintChunksDownloadUrl, deleteChunks } from '../../infra/backendClient';
import { classifyStorageError } from '../../infra/supabaseErrors';
import { EmbedJobData, EmbedJobResult } from './types';

export type { EmbedJobData, EmbedJobResult };

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
        `[embeddings.worker] signed URL expired for uploadId=${data.uploadId}, re-minting via backend`,
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
  const result = await embeddingsService.embedAndStore({ uploadId: data.uploadId, chunks });

  try {
    await deleteChunks(data.chunksPath);
  } catch (err) {
    console.warn(
      `[embeddings.worker] failed to delete chunks for uploadId=${data.uploadId}:`,
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

// ---------------------------------------------------------------------------
// Worker wiring
//
// The feature owns its background work, the same way file-upload-ocr owns its
// sweeper on the backend. index.ts only decides *when* to start it, so adding a
// second worker does not mean adding a second block of BullMQ boilerplate to
// the entrypoint.
// ---------------------------------------------------------------------------

export const embedWorker = new Worker<EmbedJobData, EmbedJobResult>(
  env.embedQueue.name,
  async (job) => {
    try {
      return await runEmbedJob(job.data);
    } catch (err) {
      const e = err as Error & { permanent?: boolean };
      if (e.permanent) {
        // CHUNKS_MISSING / INVALID_INPUT — retrying cannot help, so skip the
        // remaining attempts instead of burning backoff on a certain failure.
        throw new UnrecoverableError(e.message);
      }
      throw err;
    }
  },
  {
    connection: redisConnection,
    concurrency: env.embedQueue.concurrency,
    // Started explicitly by startEmbedWorker() once the model and vector store
    // are ready — never on import.
    autorun: false,
  },
);

embedWorker.on('completed', (job) => {
  console.log(`[ml] embed job ${job.id} completed`);
});

embedWorker.on('failed', (job, err) => {
  console.error(`[ml] embed job ${job?.id} failed:`, err.message);
});

embedWorker.on('error', (err) => {
  console.error('[ml] embed worker error:', err);
});

export function startEmbedWorker(): void {
  embedWorker.run();
  console.log(
    `[ml] embed worker listening on "${env.embedQueue.name}" with concurrency ${env.embedQueue.concurrency}`,
  );
}

export async function stopEmbedWorker(): Promise<void> {
  await embedWorker.close();
}

import { env } from '../../config/env';
import { encode } from '../../infra/embedder';
import { ChunkRow, upsertChunks } from './embeddings.repository';
import { EmbedRequest, EmbedResponse } from './embeddings.schema';

export async function embedAndStore(input: EmbedRequest): Promise<EmbedResponse> {
  const { uploadId, chunks } = input;

  const vectors = await encode(chunks.map((c) => c.text));
  const now = Date.now();

  const rows: ChunkRow[] = chunks.map((c, i) => ({
    pk: `${uploadId}:${c.index}`,
    upload_id: uploadId,
    chunk_index: c.index,
    text: c.text,
    embedding: vectors[i],
    created_at: now,
  }));

  await upsertChunks(rows);

  return {
    uploadId,
    chunkCount: rows.length,
    dim: env.embedding.dim,
    model: env.embedding.model,
  };
}

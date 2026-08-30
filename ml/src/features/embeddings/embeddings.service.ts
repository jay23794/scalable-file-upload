import { env } from '../../config/env';
import { Embedder } from '../../infra/embedder';
import { ChunkRow, EmbeddingsRepository } from './embeddings.repository';
import { EmbedRequest, EmbedResponse } from './embeddings.schema';

export class EmbeddingsService {
  constructor(
    private _embedder: Embedder,
    private _repo: EmbeddingsRepository,
  ) {}

  async embedAndStore(input: EmbedRequest): Promise<EmbedResponse> {
    const { uploadId, chunks } = input;

    const vectors = await this._embedder.encode(chunks.map((c) => c.text));
    const now = Date.now();

    const rows: ChunkRow[] = chunks.map((c, i) => ({
      // Keyed by uploadId:chunkIndex so a BullMQ retry overwrites rather than
      // duplicating.
      pk: `${uploadId}:${c.index}`,
      upload_id: uploadId,
      chunk_index: c.index,
      text: c.text,
      embedding: vectors[i],
      created_at: now,
    }));

    await this._repo.upsertChunks(rows);

    return {
      uploadId,
      chunkCount: rows.length,
      dim: env.embedding.dim,
      model: env.embedding.model,
    };
  }
}

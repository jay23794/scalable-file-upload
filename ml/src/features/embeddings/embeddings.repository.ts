import { ChunkRow, VectorStore } from '../../infra/vectorstore';

export type { ChunkRow };

/**
 * Owns all vector-store access for the embeddings feature. Mirrors
 * backend/src/features/file-upload-ocr/file-upload-ocr.repository.ts — the
 * service never touches the store directly, so swapping or faking the store is
 * a constructor argument rather than a module-mock.
 *
 * Retrieval deliberately does not live here: ingestion writes and never reads.
 * search() is owned by GenerationRepository.
 */
export class EmbeddingsRepository {
  constructor(private _store: VectorStore) {}

  async upsertChunks(rows: ChunkRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this._store.upsert(rows);
  }
}

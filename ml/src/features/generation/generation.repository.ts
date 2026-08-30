import { SearchHit, SearchInput, VectorStore } from '../../infra/vectorstore';

export type { SearchHit, SearchInput };

/**
 * Owns vector-store access for the generation feature. Retrieval lives here
 * rather than on EmbeddingsRepository: ingestion writes and never reads, so
 * search() was dead code on that slice.
 *
 * The service never touches the store directly, which is what lets a test
 * construct this with a fake store instead of reaching a live Supabase project.
 */
export class GenerationRepository {
  constructor(private _store: VectorStore) {}

  async search(input: SearchInput): Promise<SearchHit[]> {
    if (input.topK <= 0) return [];
    return this._store.search(input);
  }
}

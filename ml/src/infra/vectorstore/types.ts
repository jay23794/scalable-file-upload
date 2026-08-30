export interface ChunkRow {
  pk: string;
  upload_id: string;
  chunk_index: number;
  text: string;
  embedding: number[];
  created_at: number;
}

export interface VectorStoreSample {
  pk: string;
  upload_id: string;
  chunk_index: number;
}

export interface SearchInput {
  /** Query embedding — must come from the same model that produced the stored vectors. */
  embedding: number[];
  /** Restricts the search to these documents. Empty means search everything. */
  uploadIds: string[];
  topK: number;
}

/** A retrieved chunk. Carries `text` so callers never need a second lookup. */
export interface SearchHit {
  pk: string;
  upload_id: string;
  chunk_index: number;
  text: string;
  /** Cosine similarity in [-1, 1]; higher is closer. */
  score: number;
}

export interface VectorStore {
  readonly name: 'milvus' | 'supabase';
  init(): Promise<void>;
  upsert(rows: ChunkRow[]): Promise<void>;
  count(uploadId?: string): Promise<number>;
  sample(limit: number): Promise<VectorStoreSample[]>;
  search(input: SearchInput): Promise<SearchHit[]>;
}

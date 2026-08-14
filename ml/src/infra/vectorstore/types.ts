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

export interface VectorStore {
  readonly name: 'milvus' | 'supabase';
  init(): Promise<void>;
  upsert(rows: ChunkRow[]): Promise<void>;
  count(uploadId?: string): Promise<number>;
  sample(limit: number): Promise<VectorStoreSample[]>;
}

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

// Supabase (Postgres + pgvector) is the vector store. The adapter indirection
// that previously wrapped this — a driver switch plus a Milvus implementation —
// was removed once Supabase became the committed choice.
//
// The VectorStore interface is retained deliberately: it is the seam that lets
// services be constructed with a fake store in tests, and it keeps the
// contract explicit if a second backend is ever needed.

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
  readonly name: 'supabase';
  init(): Promise<void>;
  upsert(rows: ChunkRow[]): Promise<void>;
  count(uploadId?: string): Promise<number>;
  sample(limit: number): Promise<VectorStoreSample[]>;
  search(input: SearchInput): Promise<SearchHit[]>;
}

let clientInstance: SupabaseClient | null = null;

function getClient(): SupabaseClient {
  if (!clientInstance) {
    if (!env.supabase.url || !env.supabase.serviceRoleKey) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    clientInstance = createClient(env.supabase.url, env.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return clientInstance;
}

export const vectorStore: VectorStore = {
  name: 'supabase',

  async init(): Promise<void> {
    const client = getClient();
    const { error } = await client.from(env.supabase.table).select('pk').limit(1);
    if (error) {
      throw new Error(
        `supabase table '${env.supabase.table}' not reachable: ${error.message}. ` +
          `Run ml/sql/supabase_init.sql in the Supabase SQL editor first.`
      );
    }
  },

  async upsert(rows: ChunkRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = getClient();
    const { error } = await client
      .from(env.supabase.table)
      .upsert(rows, { onConflict: 'pk' });
    if (error) {
      throw new Error(`supabase upsert failed: ${error.message}`);
    }
  },

  async count(uploadId?: string): Promise<number> {
    const client = getClient();
    let query = client
      .from(env.supabase.table)
      .select('pk', { count: 'exact', head: true });
    if (uploadId) query = query.eq('upload_id', uploadId);
    const { count, error } = await query;
    if (error) throw new Error(`supabase count failed: ${error.message}`);
    return count ?? 0;
  },

  async sample(limit: number): Promise<VectorStoreSample[]> {
    const client = getClient();
    const { data, error } = await client
      .from(env.supabase.table)
      .select('pk, upload_id, chunk_index')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(`supabase sample failed: ${error.message}`);
    return (data ?? []).map((r) => ({
      pk: String(r.pk),
      upload_id: String(r.upload_id),
      chunk_index: Number(r.chunk_index),
    }));
  },

  async search({ embedding, uploadIds, topK }: SearchInput): Promise<SearchHit[]> {
    const client = getClient();
    const { data, error } = await client.rpc('match_document_chunks', {
      // pgvector's text input format is exactly what JSON.stringify produces for
      // a number[] — "[0.1,0.2,...]". Sending a bare array leaves PostgREST to
      // guess at the json -> vector cast; the string form always parses.
      query_embedding: JSON.stringify(embedding),
      match_count: topK,
      // null (not []) means "no filter" to the SQL function. An empty array
      // would match nothing.
      filter_upload_ids: uploadIds.length > 0 ? uploadIds : null,
    });

    if (error) {
      throw new Error(
        `supabase search failed: ${error.message}. ` +
          `If match_document_chunks is missing, run ml/sql/supabase_search.sql ` +
          `in the Supabase SQL editor.`
      );
    }

    return (data ?? []).map((r: Record<string, unknown>) => ({
      pk: String(r.pk),
      upload_id: String(r.upload_id),
      chunk_index: Number(r.chunk_index),
      text: String(r.text),
      score: Number(r.score),
    }));
  },
};

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import { ChunkRow, VectorStore, VectorStoreSample } from './types';

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

export const supabaseStore: VectorStore = {
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
};

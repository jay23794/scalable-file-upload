import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../../config/env';
import { ChunkRow, VectorStore } from './types';

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
};

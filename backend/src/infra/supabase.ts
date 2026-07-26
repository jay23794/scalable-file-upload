import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from '../config/env';

export const supabase: SupabaseClient = createClient(
  env.supabase.url,
  env.supabase.serviceRoleKey,
  {
    auth: { persistSession: false, autoRefreshToken: false },
  },
);

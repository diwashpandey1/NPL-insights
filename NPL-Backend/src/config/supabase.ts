import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.js';

/** Creates a server-only client when credentials are configured. */
export const supabase: SupabaseClient | null =
  env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
    ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
    : null;

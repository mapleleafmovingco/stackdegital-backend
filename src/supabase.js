// ADMIN client: uses the secret key, bypasses RLS. Backend only.
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';

export const supabaseAdmin = createClient(config.supabase.url, config.supabase.secretKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// supabase-js resolves with { data, error } instead of throwing. Payment code
// must never carry on after a failed read or write, so turn errors into throws.
export async function unwrap(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

export const UNIQUE_VIOLATION = '23505';

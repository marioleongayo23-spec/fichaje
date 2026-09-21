import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface PublicEnvironment {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}

export function readSupabaseConfig(env: PublicEnvironment) {
  const url = env.VITE_SUPABASE_URL?.trim();
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url && !key) return null;
  if (!url || !key) throw new Error('Supabase public configuration is incomplete');
  const parsed = new URL(url);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) ||
      parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Supabase requires an HTTPS origin (HTTP only on loopback)');
  }
  // H0 deliberately accepts only the new public key format, never legacy JWT/service-role keys.
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    throw new Error('Only a public Supabase publishable key is allowed');
  }
  return { url: parsed.origin, key };
}

export function createSupabaseClient(env: PublicEnvironment): SupabaseClient | null {
  const config = readSupabaseConfig(env);
  if (!config) return null;
  return createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

// No client instantiated on import; Auth/session strategy belongs to H1.

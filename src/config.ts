import { readSupabaseConfig, type PublicEnvironment, type SupabaseConfig } from './lib/supabase';

// Visual identity approved in HITO 9; business/security contracts remain unchanged.
export const BRAND = 'bundy';

export interface AppEnvironment extends PublicEnvironment {
  VITE_KIOSK_GATEWAY_URL?: string;
  VITE_EXPORT_LINK_URL?: string;
}
export interface AppConfig { supabase: SupabaseConfig; kioskGatewayUrl: string; exportLinkUrl: string }

// Server-only functions are reached through public URLs; never keys or secrets.
// A relative path keeps them same-origin (reverse proxy), avoiding open CORS.
export function readEndpoint(value: string | undefined, fallback: string): string {
  const raw = value?.trim() || fallback;
  if (raw.startsWith('/')) {
    if (!/^(\/[A-Za-z0-9_-]+)+\/?$/.test(raw)) throw new Error('Invalid relative endpoint');
    return raw.replace(/\/$/, '');
  }
  const parsed = new URL(raw);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if ((parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Endpoint requires HTTPS without credentials, query or fragment');
  }
  return parsed.origin + parsed.pathname.replace(/\/$/, '');
}

export function readAppConfig(env: AppEnvironment): AppConfig | null {
  const supabase = readSupabaseConfig(env);
  if (!supabase) return null;
  return {
    supabase,
    kioskGatewayUrl: readEndpoint(env.VITE_KIOSK_GATEWAY_URL, '/gateway/kiosk'),
    exportLinkUrl: readEndpoint(env.VITE_EXPORT_LINK_URL, '/gateway/export-link'),
  };
}

import { readSupabaseConfig, type PublicEnvironment, type SupabaseConfig } from './lib/supabase';

// Placeholder identity: sober and replaceable, no definitive brand.
export const BRAND = 'Fichaje';

export const STAGING_SUPABASE_ORIGIN = 'https://pvfjffeszsedslmwdvgh.supabase.co';
export const PRODUCTION_SUPABASE_ORIGIN = 'https://bypdviatamosygndeqhh.supabase.co';

export type DeploymentTier = 'staging' | 'production';

export interface AppEnvironment extends PublicEnvironment {
  VITE_DEPLOYMENT_TIER?: DeploymentTier;
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

function assertDeploymentBinding(env: AppEnvironment, supabase: SupabaseConfig): void {
  if (!env.VITE_DEPLOYMENT_TIER) return;
  const expected = env.VITE_DEPLOYMENT_TIER === 'production'
    ? PRODUCTION_SUPABASE_ORIGIN
    : STAGING_SUPABASE_ORIGIN;
  if (supabase.url !== expected) {
    throw new Error(`Deployment tier ${env.VITE_DEPLOYMENT_TIER} is bound to a different Supabase project`);
  }
  if (env.VITE_DEPLOYMENT_TIER === 'production') {
    for (const endpoint of [env.VITE_KIOSK_GATEWAY_URL, env.VITE_EXPORT_LINK_URL]) {
      if (endpoint?.trim() && !endpoint.trim().startsWith('/')) {
        throw new Error('Production server functions must use same-origin relative endpoints');
      }
    }
  }
}

export function readAppConfig(env: AppEnvironment): AppConfig | null {
  const supabase = readSupabaseConfig(env);
  if (!supabase) return null;
  assertDeploymentBinding(env, supabase);
  return {
    supabase,
    kioskGatewayUrl: readEndpoint(env.VITE_KIOSK_GATEWAY_URL, '/gateway/kiosk'),
    exportLinkUrl: readEndpoint(env.VITE_EXPORT_LINK_URL, '/gateway/export-link'),
  };
}

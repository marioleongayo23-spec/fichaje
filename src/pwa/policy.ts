// Service worker cache policy (pure, unit-tested). Only the public application
// shell listed at build time is ever stored. API, Auth, Storage, functions,
// gateway, cross-origin, authenticated and non-GET requests are never handled.
export const CACHE_PREFIX = 'fichaje-shell-';
export const SHELL_FALLBACK = '/';
const NEVER = /^\/(rest|auth|storage|functions|realtime|graphql|gateway|kiosco-api)(\/|$)/;

export interface RequestLike { method: string; url: string; mode?: string; headers?: { has(name: string): boolean } }

export function classifyRequest(request: RequestLike, origin: string, precache: ReadonlySet<string>): 'navigate' | 'asset' | null {
  if (request.method !== 'GET') return null;
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  if (url.origin !== origin || url.search || NEVER.test(url.pathname)) return null;
  if (request.headers?.has('authorization') || request.headers?.has('apikey')) return null;
  if (request.mode === 'navigate') return 'navigate';
  return precache.has(url.pathname) ? 'asset' : null;
}

export function isShellCache(name: string): boolean {
  return name.startsWith(CACHE_PREFIX);
}

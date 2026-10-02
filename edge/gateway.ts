// H7 same-origin edge for the server-only functions (Cloudflare Pages Functions).
// /gateway/kiosk/<route> and /gateway/export-link[/generate] are the only entrances the
// browser uses (no CORS). The edge: closed route/method table, fetch-metadata
// and origin policy, bounded JSON bodies, only Authorization/Content-Type go
// upstream (never client IP/forwarding headers, cookies or origin), a fresh
// ingress signature per request (functions reject anything else), no retries
// (a lost answer stays "unknown" for the client, which retries with the same
// request_id), no-store responses and no logging of bodies, tokens or IPs.
// Rate limiting by client address is a platform rule (Cloudflare WAF), never
// a header this code reads.
import { decodeSecret, INGRESS_HEADER, signIngress, type IngressComponent } from '../supabase/functions/_shared/ingress';

export interface EdgeEnv {
  FICHAJE_KIOSK_UPSTREAM?: string;
  FICHAJE_EXPORT_LINK_UPSTREAM?: string;
  FICHAJE_BILLING_UPSTREAM?: string;
  FICHAJE_INGRESS_SECRET?: string;
}

interface Route { component: IngressComponent; route: string; method: 'GET' | 'POST'; limit: number; suffix: string }

export const KIOSK_ROUTES = ['provision', 'revoke', 'reset', 'authenticate', 'record'];
export const LIMITS = { kiosk: 8192, 'export-link': 1024, billing: 1024, response: 65536 } as const;
export const UPSTREAM_TIMEOUT_MS = 15000;

const HEADERS = {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cross-Origin-Resource-Policy': 'same-origin',
};
const reply = (status: number, error: string, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...HEADERS, ...extra } });

export function resolveRoute(pathname: string): Route | null {
  const match = /^\/gateway\/(kiosk|export-link)(\/[a-z/]*)?$/.exec(pathname);
  if (!match) return null;
  const component = match[1] as IngressComponent;
  const rest = (match[2] ?? '').replace(/\/$/, '');
  if (rest === '/health/live' || rest === '/health/ready') return { component, route: rest.slice(1), method: 'GET', limit: 0, suffix: rest };
  if (component === 'kiosk' && KIOSK_ROUTES.includes(rest.slice(1))) return { component, route: rest.slice(1), method: 'POST', limit: LIMITS.kiosk, suffix: rest };
  if (component === 'export-link' && rest === '') return { component, route: 'sign', method: 'POST', limit: LIMITS['export-link'], suffix: '' };
  if (component === 'export-link' && rest === '/generate') return { component, route: 'generate', method: 'POST', limit: LIMITS['export-link'], suffix: rest };
  if (component === 'billing' && ['checkout', 'portal', 'sync'].includes(rest.slice(1))) {
    return { component, route: rest.slice(1), method: 'POST', limit: LIMITS.billing, suffix: rest };
  }
  return null;
}

// HTTPS only, except loopback HTTP for local drills; no credentials, query or fragment.
export function upstreamBase(value: string | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/$/, '');
}

async function readLimited(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

export interface EdgeOptions { nowSeconds?: number; timeoutMs?: number }

export async function handleGateway(request: Request, env: EdgeEnv, options: EdgeOptions = {}): Promise<Response> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const url = new URL(request.url);
  const route = url.search ? null : resolveRoute(url.pathname);
  if (!route) return reply(404, 'NOT_FOUND');
  if (request.method !== route.method) return reply(405, 'METHOD_NOT_ALLOWED', { Allow: route.method });
  // Browsers mark same-origin fetches; a cross-site or same-site page is refused.
  // Origin may be "null" (Referrer-Policy no-referrer); non-browser monitors send neither.
  const site = request.headers.get('sec-fetch-site');
  const origin = request.headers.get('origin');
  if ((site !== null && site !== 'same-origin') || (origin !== null && origin !== 'null' && origin !== url.origin)) return reply(403, 'FORBIDDEN');
  const base = upstreamBase(route.component === 'kiosk' ? env.FICHAJE_KIOSK_UPSTREAM
    : route.component === 'export-link' ? env.FICHAJE_EXPORT_LINK_UPSTREAM : env.FICHAJE_BILLING_UPSTREAM);
  let secret: Uint8Array<ArrayBuffer>;
  try { secret = decodeSecret(env.FICHAJE_INGRESS_SECRET ?? ''); } catch { return reply(503, 'EDGE_NOT_CONFIGURED'); }
  if (!base) return reply(503, 'EDGE_NOT_CONFIGURED');
  let body = new Uint8Array(0);
  if (route.method === 'POST') {
    if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return reply(415, 'UNSUPPORTED_MEDIA_TYPE');
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (!Number.isFinite(declared) || declared > route.limit) return reply(413, 'PAYLOAD_TOO_LARGE');
    const read = await readLimited(request.body, route.limit);
    if (!read) return reply(413, 'PAYLOAD_TOO_LARGE');
    body = read;
  }
  const headers: Record<string, string> = { Accept: 'application/json',
    [INGRESS_HEADER]: await signIngress(secret, nowSeconds, route.method, route.component, route.route, body) };
  const authorization = request.headers.get('authorization');
  if (authorization) headers.Authorization = authorization;
  if (route.method === 'POST') headers['Content-Type'] = 'application/json';
  let upstream: Response;
  try {
    upstream = await fetch(base + route.suffix, { method: route.method, headers, body: route.method === 'POST' ? body : undefined,
      redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs ?? (route.component === 'export-link' && route.route === 'generate' ? 45000 : UPSTREAM_TIMEOUT_MS)) });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return reply(timeout ? 504 : 502, timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE');
  }
  const type = upstream.headers.get('content-type')?.toLowerCase() ?? '';
  if (upstream.status < 200 || (upstream.status >= 300 && upstream.status < 400) || !type.startsWith('application/json')) {
    await upstream.body?.cancel();
    return reply(502, 'UPSTREAM_INVALID');
  }
  const payload = await readLimited(upstream.body, LIMITS.response);
  if (!payload) return reply(502, 'UPSTREAM_INVALID');
  return new Response(payload, { status: upstream.status, headers: HEADERS });
}

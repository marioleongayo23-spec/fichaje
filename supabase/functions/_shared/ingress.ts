// H7 ingress contract between the same-origin edge (Cloudflare Pages Functions)
// and the server-only functions (Supabase Edge Functions). The edge signs every
// request it forwards; when a secret is configured the functions reject any
// other request, so the public functions URL is not an alternative entrance
// that skips the edge limits, origin policy and body bounds.
//
//   x-fichaje-edge: v1.<unix seconds>.<hex HMAC-SHA256(secret, canonical)>
//   canonical = "fichaje-edge-v1\n<ts>\n<METHOD>\n<component>\n<route>\n<hex SHA-256(body)>"
//
// The value expires after INGRESS_WINDOW_S and is bound to method, function,
// route and exact body bytes, so a value seen in a log cannot open anything
// else. Dependency-free (WebCrypto only): the Deno functions and the edge
// import this same file. Secrets are base64 of at least 32 random bytes and
// live only in the platform secret stores (never Git, GitHub, VITE or logs).
export const INGRESS_HEADER = 'x-fichaje-edge';
export const INGRESS_WINDOW_S = 60;
export type IngressComponent = 'kiosk' | 'export-link';
export interface IngressPolicy { secrets: Uint8Array<ArrayBuffer>[]; required: boolean }

const enc = new TextEncoder();
const hex = (value: Uint8Array) => Array.from(value, (x) => x.toString(16).padStart(2, '0')).join('');

export function decodeSecret(value: string): Uint8Array<ArrayBuffer> {
  let raw: string;
  try { raw = atob(value.trim()); } catch { throw new Error('CONFIG_REQUIRED'); }
  const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  if (bytes.length < 32) throw new Error('CONFIG_REQUIRED');
  return bytes;
}

// Platform deployments (no local listener port) must configure a secret;
// FICHAJE_ENV staging/production also requires one. A previous secret is only
// accepted next to a current one (rotation window).
export function ingressPolicy(get: (key: string) => string | undefined, platform: boolean): IngressPolicy {
  const environment = get('FICHAJE_ENV') ?? 'local';
  if (!['local', 'ci', 'staging', 'production'].includes(environment)) throw new Error('CONFIG_REQUIRED');
  const current = get('FICHAJE_INGRESS_SECRET');
  const previous = get('FICHAJE_INGRESS_SECRET_PREVIOUS');
  if ((platform || environment === 'staging' || environment === 'production') && !current) throw new Error('CONFIG_REQUIRED');
  if (previous && !current) throw new Error('CONFIG_REQUIRED');
  const secrets = [current, previous].filter((v): v is string => !!v).map(decodeSecret);
  return { secrets, required: secrets.length > 0 };
}

export async function bodyDigest(body: Uint8Array<ArrayBuffer>): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', body)));
}

function canonical(ts: number, method: string, component: IngressComponent, route: string, digest: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`fichaje-edge-v1\n${ts}\n${method.toUpperCase()}\n${component}\n${route}\n${digest}`);
}

async function key(secret: Uint8Array<ArrayBuffer>, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signIngress(secret: Uint8Array<ArrayBuffer>, ts: number, method: string, component: IngressComponent, route: string,
  body: Uint8Array<ArrayBuffer>): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await key(secret, 'sign'), canonical(ts, method, component, route, await bodyDigest(body)));
  return `v1.${ts}.${hex(new Uint8Array(mac))}`;
}

// Constant-time HMAC verification (WebCrypto verify) against every configured
// secret; the timestamp must be within the window in both directions.
export async function verifyIngress(secrets: Uint8Array<ArrayBuffer>[], header: string | null, method: string, component: IngressComponent,
  route: string, body: Uint8Array<ArrayBuffer>, nowSeconds: number): Promise<boolean> {
  const match = /^v1\.(\d{1,12})\.([0-9a-f]{64})$/.exec(header ?? '');
  if (!match || !secrets.length) return false;
  const ts = Number(match[1]);
  if (!Number.isSafeInteger(ts) || Math.abs(nowSeconds - ts) > INGRESS_WINDOW_S) return false;
  const mac = Uint8Array.from(match[2].match(/../g) as string[], (b) => parseInt(b, 16));
  const data = canonical(ts, method, component, route, await bodyDigest(body));
  let valid = false;
  for (const secret of secrets) valid = (await crypto.subtle.verify('HMAC', await key(secret, 'verify'), mac, data)) || valid;
  return valid;
}

// Route names shared by both sides: health probes by suffix, otherwise the last
// path segment (kiosk) or the fixed signer route.
export function routeOf(component: IngressComponent, method: string, pathname: string): string {
  const health = /\/health\/(live|ready)\/?$/.exec(pathname);
  if (health) return `health/${health[1]}`;
  if (component === 'export-link') return method.toUpperCase() === 'POST' ? 'sign' : 'invalid';
  return pathname.replace(/\/$/, '').split('/').pop() || 'invalid';
}

// Bounded body read even when Content-Length is absent or false.
export async function readBounded(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); for (const c of chunks) c.fill(0); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; c.fill(0); }
  return bytes;
}

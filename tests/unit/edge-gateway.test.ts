// H7 same-origin edge (Cloudflare Pages Function logic) against a real local
// HTTP upstream: route table, origin policy, limits, forwarded headers, ingress
// signature, no retries and no-store/no-CORS answers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleGateway, resolveRoute, upstreamBase, type EdgeEnv } from '../../edge/gateway';
import { verifyIngress } from '../../supabase/functions/_shared/ingress';
import { PAGES_ROUTES, pagesHeaders } from '../../vite.config';

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: Buffer }
const seen: Seen[] = [];
let mode: 'json' | 'html' | 'redirect' | 'hang' | 'big' | 'conflict' = 'json';
let server: Server;
let base: string;
const secretBytes = new Uint8Array(32).map((_, i) => (i * 7 + 3) & 255);
const secret = Buffer.from(secretBytes).toString('base64');
const APP = 'https://fichaje.example.invalid';

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      if (mode === 'hang') return;
      if (mode === 'redirect') { res.writeHead(302, { Location: 'https://elsewhere.invalid/' }); res.end(); return; }
      if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>'); return; }
      if (mode === 'big') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ x: 'a'.repeat(70000) })); return; }
      const status = mode === 'conflict' ? 409 : 200;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Set-Cookie': 'upstream=1', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(mode === 'conflict' ? { error: 'VERSION_CONFLICT' } : { ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.closeAllConnections(); server.close(); });

const env = (): EdgeEnv => ({ FICHAJE_KIOSK_UPSTREAM: `${base}/functions/v1/kiosk`, FICHAJE_EXPORT_LINK_UPSTREAM: `${base}/functions/v1/export-link`,
  FICHAJE_INGRESS_SECRET: secret });
const post = (path: string, body: string, headers: Record<string, string> = {}) => new Request(APP + path, {
  method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic.jwt.value', ...headers } });

function expectEdgeHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  expect(response.headers.get('set-cookie')).toBeNull();
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
}

describe('H7 edge gateway', () => {
  it('admits only the closed route table', () => {
    expect(resolveRoute('/gateway/kiosk/record')).toMatchObject({ component: 'kiosk', route: 'record', method: 'POST', limit: 8192 });
    expect(resolveRoute('/gateway/kiosk/health/ready')).toMatchObject({ route: 'health/ready', method: 'GET' });
    expect(resolveRoute('/gateway/export-link')).toMatchObject({ component: 'export-link', route: 'sign', limit: 1024, suffix: '' });
    expect(resolveRoute('/gateway/export-link/generate')).toMatchObject({ component: 'export-link', route: 'generate', limit: 1024, suffix: '/generate' });
    expect(resolveRoute('/gateway/export-link/health/live')).toMatchObject({ route: 'health/live', method: 'GET' });
    for (const bad of ['/gateway/kiosk', '/gateway/kiosk/debug', '/gateway/kiosk/record/extra', '/gateway/export-link/sign', '/gateway/other',
      '/gateway/kiosk/Record', '/gateway/kiosk/../record', '/rest/v1/rpc/x', '/gateway/kiosk/health']) {
      expect(resolveRoute(bad), bad).toBeNull();
    }
    expect(upstreamBase('https://ref.supabase.co/functions/v1/kiosk/')).toBe('https://ref.supabase.co/functions/v1/kiosk');
    expect(upstreamBase('http://127.0.0.1:8765')).toBe('http://127.0.0.1:8765');
    for (const bad of [undefined, '', 'http://ref.supabase.co/x', 'https://user:pw@ref.supabase.co', 'https://ref.supabase.co/x?y=1', 'ftp://x', 'not a url']) {
      expect(upstreamBase(bad), String(bad)).toBeNull();
    }
  });

  it('forwards only authorization and a fresh body-bound signature, never client network or cookie headers', async () => {
    seen.length = 0; mode = 'json';
    const body = '{"organization_id":"00000000-0000-4000-8000-000000000001","device_id":"x","code":"c","pin":"12345678"}';
    const response = await handleGateway(post('/gateway/kiosk/authenticate', body, {
      'X-Forwarded-For': '203.0.113.9', 'X-Real-IP': '203.0.113.9', Forwarded: 'for=203.0.113.9', 'CF-Connecting-IP': '203.0.113.9',
      'True-Client-IP': '203.0.113.9', Cookie: 'a=b', Origin: APP, 'Sec-Fetch-Site': 'same-origin', 'User-Agent': 'synthetic' }), env());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expectEdgeHeaders(response);
    expect(seen).toHaveLength(1);
    const [request] = seen;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/functions/v1/kiosk/authenticate');
    expect(request.body.toString()).toBe(body);
    const forwarded = Object.keys(request.headers).filter((h) => !['host', 'connection', 'content-length', 'accept-encoding', 'accept-language',
      'sec-fetch-mode', 'user-agent'].includes(h)).sort();
    expect(forwarded).toEqual(['accept', 'authorization', 'content-type', 'x-fichaje-edge']);
    expect(request.headers['user-agent']).not.toBe('synthetic');
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyIngress([secretBytes], String(request.headers['x-fichaje-edge']), 'POST', 'kiosk', 'authenticate',
      new Uint8Array(request.body), now)).toBe(true);
    expect(await verifyIngress([secretBytes], String(request.headers['x-fichaje-edge']), 'POST', 'kiosk', 'record',
      new Uint8Array(request.body), now)).toBe(false);
  });

  it('signs health, generation and download routes for the export function', async () => {
    seen.length = 0; mode = 'json';
    expect((await handleGateway(new Request(APP + '/gateway/export-link/health/ready'), env())).status).toBe(200);
    expect((await handleGateway(post('/gateway/export-link', '{"organization_id":"a","job_id":"b"}'), env())).status).toBe(200);
    expect((await handleGateway(post('/gateway/export-link/generate', '{"organization_id":"a","job_id":"b"}'), env())).status).toBe(200);
    expect(seen.map((s) => s.url)).toEqual(['/functions/v1/export-link/health/ready', '/functions/v1/export-link', '/functions/v1/export-link/generate']);
    const now = Math.floor(Date.now() / 1000);
    expect(await verifyIngress([secretBytes], String(seen[0].headers['x-fichaje-edge']), 'GET', 'export-link', 'health/ready', new Uint8Array(0), now)).toBe(true);
    expect(await verifyIngress([secretBytes], String(seen[1].headers['x-fichaje-edge']), 'POST', 'export-link', 'sign', new Uint8Array(seen[1].body), now)).toBe(true);
    expect(await verifyIngress([secretBytes], String(seen[2].headers['x-fichaje-edge']), 'POST', 'export-link', 'generate', new Uint8Array(seen[2].body), now)).toBe(true);
  });

  it('rejects before contacting the upstream: route, method, query, origin, media type, size and configuration', async () => {
    seen.length = 0; mode = 'json';
    const cases: [Request, number, EdgeEnv?][] = [
      [post('/gateway/kiosk/debug', '{}'), 404],
      [post('/gateway/kiosk/record?x=1', '{}'), 404],
      [new Request(APP + '/gateway/kiosk/record'), 405],
      [new Request(APP + '/gateway/kiosk/record', { method: 'OPTIONS', headers: { Origin: 'https://evil.invalid' } }), 405],
      [post('/gateway/kiosk/health/ready', '{}'), 405],
      [post('/gateway/kiosk/record', '{}', { 'Sec-Fetch-Site': 'cross-site' }), 403],
      [post('/gateway/kiosk/record', '{}', { 'Sec-Fetch-Site': 'same-site' }), 403],
      [post('/gateway/kiosk/record', '{}', { Origin: 'https://evil.invalid' }), 403],
      [post('/gateway/kiosk/record', '{}', { 'Content-Type': 'text/plain' }), 415],
      [post('/gateway/kiosk/record', 'x'.repeat(8193)), 413],
      [post('/gateway/export-link', 'x'.repeat(1025)), 413],
      [post('/gateway/export-link/generate', 'x'.repeat(1025)), 413],
      [post('/gateway/kiosk/record', '{}'), 503, { ...env(), FICHAJE_INGRESS_SECRET: undefined }],
      [post('/gateway/kiosk/record', '{}'), 503, { ...env(), FICHAJE_INGRESS_SECRET: Buffer.alloc(16).toString('base64') }],
      [post('/gateway/kiosk/record', '{}'), 503, { ...env(), FICHAJE_KIOSK_UPSTREAM: 'http://ref.supabase.co/functions/v1/kiosk' }],
    ];
    for (const [request, status, custom] of cases) {
      const response = await handleGateway(request, custom ?? env());
      expect(response.status, `${request.method} ${request.url}`).toBe(status);
      expectEdgeHeaders(response);
    }
    expect(seen).toHaveLength(0);
    // Same-origin browser requests may carry Origin: null (Referrer-Policy: no-referrer).
    expect((await handleGateway(post('/gateway/kiosk/record', '{}', { Origin: 'null', 'Sec-Fetch-Site': 'same-origin' }), env())).status).toBe(200);
    // A body larger than declared is cut at the limit even without Content-Length.
    const stream = new ReadableStream({ start(c) { for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1024)); c.close(); } });
    const chunked = new Request(APP + '/gateway/kiosk/record', { method: 'POST', body: stream, headers: { 'Content-Type': 'application/json' }, duplex: 'half' } as RequestInit);
    expect((await handleGateway(chunked, env())).status).toBe(413);
  });

  it('passes business answers through once, never retries and maps upstream faults to 502/504', async () => {
    mode = 'conflict'; seen.length = 0;
    const conflict = await handleGateway(post('/gateway/kiosk/record', '{"a":1}'), env());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'VERSION_CONFLICT' });
    for (const [kind, status] of [['html', 502], ['redirect', 502], ['big', 502]] as const) {
      mode = kind; seen.length = 0;
      const response = await handleGateway(post('/gateway/kiosk/record', '{"a":1}'), env());
      expect(response.status, kind).toBe(status);
      expectEdgeHeaders(response);
      expect(seen, kind).toHaveLength(1);
    }
    mode = 'hang'; seen.length = 0;
    const timeout = await handleGateway(post('/gateway/kiosk/record', '{"a":1}'), env(), { timeoutMs: 300 });
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toEqual({ error: 'UPSTREAM_TIMEOUT' });
    expect(seen).toHaveLength(1);
    const down = await handleGateway(post('/gateway/kiosk/record', '{"a":1}'), { ...env(), FICHAJE_KIOSK_UPSTREAM: 'http://127.0.0.1:9' });
    expect(down.status).toBe(502);
    expect(await down.json()).toEqual({ error: 'UPSTREAM_UNAVAILABLE' });
  });

  it('builds the static policy: CSP with frame-ancestors, HSTS, no CORS or referrer, immutable assets, /gateway routes only', () => {
    const headers = pagesHeaders({ VITE_SUPABASE_URL: 'https://ref.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x' });
    expect(headers).toContain("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'");
    expect(headers).toContain("connect-src 'self' https://ref.supabase.co");
    expect(headers).toContain("frame-ancestors 'none'");
    expect(headers).toContain('Strict-Transport-Security: max-age=31536000');
    expect(headers).toContain('! Access-Control-Allow-Origin');
    expect(headers).toContain('Referrer-Policy: no-referrer');
    expect(headers).toMatch(/\/assets\/\*\n {2}! Cache-Control\n {2}Cache-Control: public, max-age=31536000, immutable/);
    expect(headers).not.toContain('sb_publishable_x');
    expect(PAGES_ROUTES).toEqual({ version: 1, include: ['/gateway/*'], exclude: [] });
  });
});

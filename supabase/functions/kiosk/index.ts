// Server-only gateway; also served unchanged by Deno in the real integration suite.
import postgres from 'postgres';
import { networkIdentifier } from './network.ts';
import { argon2id, argon2Verify } from 'hash-wasm';
import { classifySql, healthHandler, opsEvent, type ErrorClass, type Operation, type Outcome } from '../_shared/ops.ts';

const env = (key: string) => { const value = Deno.env.get(key); if (!value) throw new Error('CONFIG_REQUIRED'); return value; };
const authURL = env('KIOSK_AUTH_URL');
const apiKey = env('KIOSK_ANON_KEY');
const provisionKey = env('KIOSK_AUTH_PROVISION_KEY'); // Auth admin provisioning only, NEVER database access.
const pepper = Uint8Array.from(atob(env('KIOSK_PEPPER')), c => c.charCodeAt(0));
const networkSecret = Uint8Array.from(atob(env('KIOSK_NETWORK_SECRET')), c => c.charCodeAt(0));
if (networkSecret.length < 32 || btoa(String.fromCharCode(...networkSecret)) === btoa(String.fromCharCode(...pepper))) throw new Error('CONFIG_REQUIRED');
if (pepper.length < 32) throw new Error('CONFIG_REQUIRED');
const db = postgres(env('KIOSK_DATABASE_URL'), { max: 8, prepare: false, onnotice: () => {}, debug: false,
  connection: { application_name: 'kiosk-gateway', statement_timeout: 10000, lock_timeout: 5000, idle_in_transaction_session_timeout: 10000 } });
const enc = new TextEncoder();
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const b64 = (v: Uint8Array) => btoa(String.fromCharCode(...v));
const hex = (v: Uint8Array) => Array.from(v, x => x.toString(16).padStart(2, '0')).join('');
const digest = async (v: string) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(v))));
const hash = (pin: string) => argon2id({ password: pin, secret: pepper, salt: random(16), parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' });
const dummy = await hash(hex(random(32)));
// Rejection sampling avoids modulo bias. Never accepted from manager/client input.
function newPin() { let s = ''; while (s.length < 8) for (const b of random(16)) if (b < 250 && s.length < 8) s += String(b % 10); return s; }
async function seal(value: string, jwk: JsonWebKey) {
  if (jwk.kty !== 'RSA' || jwk.d || !jwk.n || jwk.n.length < 342) throw new Error('INVALID_INPUT');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  return b64(new Uint8Array(await crypto.subtle.encrypt('RSA-OAEP', key, enc.encode(value))));
}
const response = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0', Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } });
const fail = () => response(403, { error: 'AUTH_FAILED' });
const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
type Tx = postgres.TransactionSql;
async function identity(tx: Tx, id: string) { await tx.unsafe("select set_config('request.jwt.claim.sub',$1,true)",[id]); }
async function preflight(id: string, org: string, req: string, op: string, payload: postgres.JSONValue) {
  return await db.begin(async tx => { await identity(tx,id); const [r] = await tx.unsafe('select private.kiosk_admin_prepare($1::uuid,$2::uuid,$3,$4::jsonb) as r',[org,req,op,tx.json(payload)]); return r.r; });
}
async function apply(id: string, org: string, req: string, op: string, payload: postgres.JSONValue, data: postgres.JSONValue) {
  return await db.begin(async tx => { await identity(tx,id); const [r] = await tx.unsafe('select private.kiosk_admin_apply($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb) as r',[org,req,op,tx.json(payload),tx.json(data)]); return r.r; });
}

// OPS-02: liveness and bounded, cached readiness of the two dependencies.
const health = healthHandler('kiosk-gateway', {
  auth: async () => {
    const res = await fetch(authURL + '/auth/v1/health', { headers: { apikey: apiKey }, signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    if (!res.ok) throw new Error('AUTH_UNAVAILABLE');
  },
  database: async () => { await db`select 1`; },
});
interface Trace { operation: Operation; outcome: Outcome; errorClass: ErrorClass; stage: string; requestId?: unknown }
const ACTIONS = ['CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT'];

// One structured event per request, emitted after the uniform 300 ms floor so
// logging cannot create a timing difference between outcomes.
export async function handler(req: Request, info: Deno.ServeHandlerInfo): Promise<Response> {
  if (req.method === 'GET') {
    const probe = await health(new URL(req.url).pathname);
    if (probe) return probe;
  }
  const started = performance.now();
  const trace: Trace = { operation: 'request.rejected', outcome: 'rejected', errorClass: 'INVALID_INPUT', stage: 'input' };
  const res = await handle(req, info, trace);
  opsEvent('kiosk-gateway', trace.operation, trace.outcome, { error_class: trace.errorClass, request_id: trace.requestId,
    stage: trace.outcome === 'success' ? undefined : trace.stage, duration_ms: performance.now() - started, status: res.status });
  return res;
}

async function handle(req: Request, info: Deno.ServeHandlerInfo, trace: Trace): Promise<Response> {
  const started = performance.now();
  const accept = (data: unknown) => { trace.outcome = 'success'; trace.errorClass = 'NONE'; return response(200, data); };
  let body: Record<string, unknown> = {};
  let stage = 'input';
  try {
    if (req.method !== 'POST' || !req.headers.get('content-type')?.startsWith('application/json')) return fail();
    // Bounded streaming read even when Content-Length is absent or false.
    const reader = req.body?.getReader(); if (!reader) return fail();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 8192) { await reader.cancel(); return fail(); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c,offset); offset += c.length; }
    body = JSON.parse(new TextDecoder().decode(bytes)); bytes.fill(0); for (const c of chunks) c.fill(0);
    const route = new URL(req.url).pathname.split('/').pop();
    const permitted: Record<string, string[]> = {
      provision: ['organization_id','request_id','device_id','name','expires_at','delivery_key'],
      revoke: ['organization_id','request_id','device_id'],
      reset: ['organization_id','request_id','employee_id','delivery_key'],
      // KIO-H6-01: the kiosk proves code+PIN before it learns state; it never names employee, action or version.
      authenticate: ['organization_id','device_id','code','pin'],
      record: ['organization_id','request_id','device_id','challenge','action','expected_version'],
    };
    if (!route || !permitted[route] || Object.keys(body).some(k => !permitted[route].includes(k))) return fail();
    trace.operation = route === 'authenticate' ? 'kiosk.authenticate' : route === 'record'
      ? (ACTIONS.includes(body.action as string) ? `clock.${body.action}` as Operation : 'request.rejected') : `kiosk.${route}` as Operation;
    trace.requestId = body.request_id;
    const org = body.organization_id as string, request = body.request_id as string, device = body.device_id as string;
    if (!uuid(org) || (route !== 'authenticate' && !uuid(request))) return fail();
    stage = 'jwt'; trace.stage = stage; trace.errorClass = 'UNAUTHENTICATED';
    const auth = await fetch(authURL + '/auth/v1/user', { headers: { apikey: apiKey, Authorization: req.headers.get('authorization') || '' }, signal: AbortSignal.timeout(5000) });
    if (!auth.ok) return fail();
    const { id } = await auth.json(); if (!uuid(id)) return fail();
    trace.errorClass = 'INVALID_INPUT';
    if (route === 'provision' || route === 'reset' || route === 'revoke') {
      const target = route === 'reset' ? body.employee_id as string : device;
      if (!uuid(target)) return fail();
      const op = 'kiosk_' + route;
      const payload: postgres.JSONValue = { target, ...(route === 'provision' ? { name: body.name as string, expires_at: body.expires_at as string } : {}),
        ...(route !== 'revoke' ? { delivery_key: body.delivery_key as postgres.JSONValue } : {}) };
      stage = 'preflight'; trace.stage = stage;
      const prior = await preflight(id,org,request,op,payload); if (prior) return accept(prior);
      if (route === 'reset') {
        let pin = newPin();
        const delivery = await seal(pin,body.delivery_key as JsonWebKey);
        const pin_hash = await hash(pin); pin = '';
        return accept(await apply(id,org,request,op,payload,{ pin_hash, delivery }));
      }
      if (route === 'revoke') return accept(await apply(id,org,request,op,payload,{}));
      // Fresh technical Auth identity; never reuse a human account. DB checks membership exclusion.
      const email = crypto.randomUUID() + '@kiosk.invalid'; let password = b64(random(32));
      stage = 'device_seal'; trace.stage = stage;
      const delivery = await seal(JSON.stringify({ email, password }),body.delivery_key as JsonWebKey);
      stage = 'auth_create'; trace.stage = stage; trace.errorClass = 'AUTH_UNAVAILABLE';
      const created = await fetch(authURL + '/auth/v1/admin/users', { method: 'POST', headers: { apikey: provisionKey, Authorization: 'Bearer ' + provisionKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, email_confirm: true, app_metadata: { identity_kind: 'KIOSK' } }), signal: AbortSignal.timeout(5000) });
      password = '';
      if (!created.ok) return fail();
      const user = await created.json();
      stage = 'device_commit'; trace.stage = stage; trace.errorClass = 'INVALID_INPUT';
      const discardUnbound = () => fetch(authURL + '/auth/v1/admin/users/' + user.id, { method: 'DELETE', headers: { apikey: provisionKey, Authorization: 'Bearer ' + provisionKey }, signal: AbortSignal.timeout(5000) }).catch(() => {});
      try {
        const receipt = await apply(id,org,request,op,payload,{ auth_user_id: user.id, delivery });
        // A concurrent request may have won after our preflight. Its persistent
        // encrypted receipt identifies the winner without exposing any secret.
        if (receipt.delivery !== delivery) await discardUnbound();
        return accept(receipt);
      }
      catch (err) {
        // Best effort compensation for an unbound Auth identity; never delete a bound device.
        const bound = await preflight(id,org,request,op,payload).catch(() => null);
        if (bound) { if (bound.delivery !== delivery) await discardUnbound(); return accept(bound); }
        await discardUnbound();
        throw err;
      }
    }
    if (!uuid(device)) return fail();
    stage = 'database'; trace.stage = stage;
    if (route === 'authenticate') {
      if (typeof body.code !== 'string' || body.code.length > 64 || typeof body.pin !== 'string' || !/^\d{8,32}$/.test(body.pin)) return fail();
      let blocked = false;
      const network = await networkIdentifier(info.remoteAddr,org,networkSecret);
      // Two candidate secrets for every request (same work whatever the outcome);
      // the database stores only their hashes, one per legal action it offers.
      const tokens = [hex(random(32)), hex(random(32))];
      const hashes = await Promise.all(tokens.map(digest));
      const result = await db.begin(async tx => {
        await identity(tx,id);
        const [r] = await tx.unsafe('select private.kiosk_auth_begin($1::uuid,$2::uuid,$3,$4) as r',[org,device,body.code as string,network]);
        const a = r.r;
        // Same Argon2 work for unknown, wrong and blocked credentials.
        const valid = await argon2Verify({ password: body.pin as string, secret: pepper, hash: a.pin_hash || dummy });
        body.pin = '';
        blocked = a.blocked === true;
        if (!valid || a.blocked || !a.employee_id || !a.pin_hash) return null; // COMMIT failure buckets.
        const [g] = await tx.unsafe('select private.kiosk_auth_grant($1::uuid,$2::uuid,$3,$4::bigint,$5,$6::jsonb) as r',
          [org,device,body.code as string,a.credential_version,network,tx.json(hashes)]);
        const grant = g.r as { state: string; version: number; challenges: { action: string; request_id: string }[] };
        // Only state, version, legal actions and one bound challenge per action leave the gateway.
        return { state: grant.state, version: grant.version, actions: grant.challenges.map(c => c.action),
          challenges: grant.challenges.map((c, i) => ({ action: c.action, request_id: c.request_id, challenge: tokens[i] })) };
      });
      tokens.fill('');
      trace.errorClass = blocked ? 'RATE_LIMITED' : 'AUTH_FAILED';
      return result ? accept(result) : fail();
    }
    const action = body.action as string, expected = body.expected_version as number;
    if (!['CLOCK_IN','BREAK_START','BREAK_END','CLOCK_OUT'].includes(action) || !Number.isSafeInteger(expected) || expected < 0) return fail();
    if (typeof body.challenge !== 'string' || !/^[0-9a-f]{64}$/.test(body.challenge)) return fail();
    const tokenHash = await digest(body.challenge); body.challenge = '';
    const result = await db.begin(async tx => {
      await identity(tx,id);
      const [r] = await tx.unsafe('select private.kiosk_record($1::uuid,$2::uuid,$3::public.time_action,$4::bigint,$5::uuid,$6) as r',[org,device,action,expected,request,tokenHash]);
      return r.r;
    });
    return accept(result); // sql.begin resolves only after COMMIT.
  } catch (err) {
    // Only a stable class and the fixed stage are logged (OBS-01), after the
    // time floor; never driver messages, queries, parameters, hashes or tokens.
    const classified = classifySql(err);
    const network = !(typeof err === 'object' && err && 'code' in err) && (stage === 'jwt' || stage === 'auth_create');
    trace.outcome = stage === 'input' || classified.outcome === 'rejected' ? 'rejected' : 'failure';
    trace.errorClass = stage === 'input' ? 'INVALID_INPUT' : network ? 'AUTH_UNAVAILABLE' : classified.errorClass;
    // Never serialize driver errors: they contain query/parameters, hashes and tokens.
    const safe = new Set(['INVALID_TRANSITION','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','CLOCK_REGRESSION','POLICY_REQUIRED']);
    const message = err instanceof Error ? err.message : '';
    if (safe.has(message)) return response(message.includes('CONFLICT') ? 409 : 400,{ error: message });
    if (typeof err === 'object' && err && 'code' in err && ['55P03','57014'].includes(String(err.code))) return response(503,{ error: 'RETRYABLE_TIMEOUT' });
    return fail();
  } finally {
    body.pin = ''; body.challenge = ''; body = {};
    await new Promise(r => setTimeout(r,Math.max(0,300 - (performance.now()-started))));
  }
}
Deno.serve({ hostname: Deno.env.get('KIOSK_LISTEN_HOST') || '127.0.0.1', port: Number(Deno.env.get('KIOSK_PORT') || 8000), onListen: () => {} },handler);

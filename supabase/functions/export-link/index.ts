// Server-only signer. The service key is used solely after JWT and RPC checks.
import { healthHandler, opsEvent, type ErrorClass, type Outcome } from '../_shared/ops.ts';
import { INGRESS_HEADER, ingressPolicy, readBounded, routeOf, verifyIngress } from '../_shared/ingress.ts';

const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error('CONFIG_REQUIRED');
  return value;
};
const endpoint = required('SUPABASE_URL');
const anonKey = required('SUPABASE_ANON_KEY');
const storageKey = required('SUPABASE_SERVICE_ROLE_KEY');
// H7: on the platform (no local port) only edge-signed requests are served.
const listenPort = Deno.env.get('EXPORT_LINK_PORT');
const ingress = ingressPolicy(k => Deno.env.get(k), !listenPort);
const signedByEdge = async (request: Request, body: Uint8Array<ArrayBuffer>) => !ingress.required || await verifyIngress(ingress.secrets,
  request.headers.get(INGRESS_HEADER), request.method, 'export-link', routeOf('export-link', request.method, new URL(request.url).pathname),
  body, Date.now() / 1000);
const denied = () => new Response(JSON.stringify({ error: 'FORBIDDEN' }), {
  status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' },
});
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

// OPS-02 readiness: Auth, PostgREST (an anonymous read must reach PostgreSQL
// and be refused with 42501) and Storage. The service key is never used here.
const health = healthHandler('export-link', {
  auth: async () => {
    const res = await fetch(endpoint + '/auth/v1/health', { headers: { apikey: anonKey }, signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    if (!res.ok) throw new Error('AUTH_UNAVAILABLE');
  },
  rest: async () => {
    const res = await fetch(endpoint + '/rest/v1/organizations?select=id&limit=1', {
      headers: { apikey: anonKey, Authorization: 'Bearer ' + anonKey }, signal: AbortSignal.timeout(2000) });
    const body = await res.json().catch(() => null);
    if (res.status !== 401 || body?.code !== '42501') throw new Error('REST_UNAVAILABLE');
  },
  storage: async () => {
    const res = await fetch(endpoint + '/storage/v1/status', { headers: { apikey: anonKey }, signal: AbortSignal.timeout(2000) });
    await res.body?.cancel();
    if (!res.ok) throw new Error('STORAGE_UNAVAILABLE');
  },
});

interface Trace { outcome: Outcome; errorClass: ErrorClass }

async function sign(request: Request, trace: Trace): Promise<Response> {
  try {
    if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) return denied();
    if (Number(request.headers.get('content-length') || 0) > 1024) return denied();
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) return denied();
    const bytes = await readBounded(request, 1024);
    if (!bytes) return denied();
    if (!await signedByEdge(request, bytes)) { trace.errorClass = 'FORBIDDEN'; return denied(); }
    const params: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof params !== 'object' || !params) return denied();
    const fields = params as Record<string, unknown>;
    if (Object.keys(fields).sort().join(',') !== 'job_id,organization_id' ||
      !uuid(fields.organization_id) || !uuid(fields.job_id)) return denied();
    trace.errorClass = 'UNAUTHENTICATED';
    const auth = await fetch(endpoint + '/auth/v1/user', { headers: { apikey: anonKey, Authorization: authorization }, signal: AbortSignal.timeout(5000) });
    if (!auth.ok) return denied();
    trace.errorClass = 'FORBIDDEN';
    const result = await fetch(endpoint + '/rest/v1/rpc/authorize_export_link', {
      method: 'POST', headers: { apikey: anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_organization_id: fields.organization_id, p_job_id: fields.job_id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) return denied();
    const permit = await result.json();
    const path = permit?.path;
    const seconds = permit?.expires_in;
    trace.errorClass = 'INVALID_RESPONSE';
    if (path !== `${fields.organization_id}/${fields.job_id}.zip` ||
      !Number.isInteger(seconds) || seconds < 1 || seconds > 300) return denied();
    trace.errorClass = 'STORAGE_ERROR';
    const signed = await fetch(endpoint + '/storage/v1/object/sign/fichaje-evidence/' + path, {
      method: 'POST', headers: { apikey: storageKey, Authorization: 'Bearer ' + storageKey,
        'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds }),
      signal: AbortSignal.timeout(5000),
    });
    if (!signed.ok) return denied();
    const receipt = await signed.json();
    if (typeof receipt.signedURL !== 'string' || !receipt.signedURL.startsWith('/object/sign/')) return denied();
    trace.outcome = 'success';
    trace.errorClass = 'NONE';
    return new Response(JSON.stringify({ url: endpoint + '/storage/v1' + receipt.signedURL, expires_in: seconds }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' },
    });
  } catch {
    // Parse errors keep INVALID_INPUT; an unreachable dependency is classified
    // by the step that failed. The signed URL is never logged.
    const unreachable: Partial<Record<ErrorClass, ErrorClass>> = { UNAUTHENTICATED: 'AUTH_UNAVAILABLE', FORBIDDEN: 'UPSTREAM_5XX' };
    if (trace.errorClass !== 'INVALID_INPUT') {
      trace.outcome = 'failure';
      trace.errorClass = unreachable[trace.errorClass] ?? trace.errorClass;
    }
    return denied();
  }
}

// One structured event per request (OBS-01): outcome and stable class only.
export async function handler(request: Request): Promise<Response> {
  if (request.method === 'GET') {
    if (!await signedByEdge(request, new Uint8Array(0))) {
      opsEvent('export-link', 'request.rejected', 'rejected', { error_class: 'FORBIDDEN', stage: 'ingress', status: 403 });
      return denied();
    }
    const probe = await health(new URL(request.url).pathname);
    if (probe) return probe;
  }
  const started = performance.now();
  const trace: Trace = { outcome: 'rejected', errorClass: 'INVALID_INPUT' };
  const response = await sign(request, trace);
  opsEvent('export-link', 'export.link', trace.outcome, { error_class: trace.errorClass,
    duration_ms: performance.now() - started, status: response.status });
  return response;
}

if (import.meta.main) {
  if (listenPort) Deno.serve({ hostname: '127.0.0.1', port: Number(listenPort), onListen: () => {} }, handler);
  else Deno.serve(handler);
}

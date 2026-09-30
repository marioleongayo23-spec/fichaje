// Server-only export generator + signer. Labour evidence is read only after
// user authorization; PostgreSQL work runs under the existing minimal
// fichaje_export_worker role. Storage service credentials never reach clients.
import postgres from 'npm:postgres@3.4.8';
import { healthHandler, opsEvent, type ErrorClass, type Outcome } from '../_shared/ops.ts';
import { INGRESS_HEADER, ingressPolicy, readBounded, routeOf, verifyIngress } from '../_shared/ingress.ts';
import { packageSnapshot, type EvidenceSnapshot } from './package.ts';

const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error('CONFIG_REQUIRED');
  return value;
};
const endpoint = required('SUPABASE_URL');
const anonKey = required('SUPABASE_ANON_KEY');
const storageKey = required('SUPABASE_SERVICE_ROLE_KEY');
const dbUrl = Deno.env.get('SUPABASE_DB_URL') ?? Deno.env.get('EXPORT_DATABASE_URL');
const database = dbUrl ? postgres(dbUrl, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 5 }) : null;

// H7: on the platform (no local port) only edge-signed requests are served.
const listenPort = Deno.env.get('EXPORT_LINK_PORT');
const ingress = ingressPolicy(k => Deno.env.get(k), !listenPort);
const signedByEdge = async (request: Request, body: Uint8Array<ArrayBuffer>) => !ingress.required || await verifyIngress(ingress.secrets,
  request.headers.get(INGRESS_HEADER), request.method, 'export-link', routeOf('export-link', request.method, new URL(request.url).pathname),
  body, Date.now() / 1000);

const JSON_HEADERS = {
  'Content-Type': 'application/json', 'Cache-Control': 'no-store',
  'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer',
};
const denied = () => new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403, headers: JSON_HEADERS });
const unavailable = () => new Response(JSON.stringify({ error: 'UNAVAILABLE' }), { status: 503, headers: JSON_HEADERS });
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

async function digest(data: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return Array.from(hash, (x) => x.toString(16).padStart(2, '0')).join('');
}

async function storage(method: 'POST' | 'GET' | 'DELETE', path: string, body?: Uint8Array): Promise<Uint8Array> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  let url = endpoint + '/storage/v1/object/fichaje-evidence/' + encoded;
  const headers: Record<string, string> = {
    apikey: storageKey, Authorization: 'Bearer ' + storageKey,
    'Cache-Control': 'no-store',
  };
  let payload: BodyInit | undefined = body;
  if (method === 'POST') {
    headers['Content-Type'] = 'application/zip';
    headers['x-upsert'] = 'true';
  } else if (method === 'DELETE') {
    url = endpoint + '/storage/v1/object/fichaje-evidence';
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify({ prefixes: [path] });
  }
  const response = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(15000) });
  if (!response.ok) { await response.body?.cancel(); throw new Error('STORAGE_ERROR'); }
  return new Uint8Array(await response.arrayBuffer());
}

interface Trace { outcome: Outcome; errorClass: ErrorClass }
interface RequestFields { authorization: string; organizationId: string; jobId: string }

async function validatedFields(request: Request, trace: Trace): Promise<RequestFields | null> {
  if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) return null;
  if (Number(request.headers.get('content-length') || 0) > 1024) return null;
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const bytes = await readBounded(request, 1024);
  if (!bytes) return null;
  if (!await signedByEdge(request, bytes)) { trace.errorClass = 'FORBIDDEN'; return null; }
  let params: unknown;
  try { params = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  if (typeof params !== 'object' || !params) return null;
  const fields = params as Record<string, unknown>;
  if (Object.keys(fields).sort().join(',') !== 'job_id,organization_id' ||
    !uuid(fields.organization_id) || !uuid(fields.job_id)) return null;

  trace.errorClass = 'UNAUTHENTICATED';
  const auth = await fetch(endpoint + '/auth/v1/user', {
    headers: { apikey: anonKey, Authorization: authorization }, signal: AbortSignal.timeout(5000),
  });
  if (!auth.ok) { await auth.body?.cancel(); return null; }
  await auth.body?.cancel();
  return { authorization, organizationId: fields.organization_id, jobId: fields.job_id };
}

// OPS-02 readiness includes the database dependency used by generation.
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
  database: async () => {
    if (!database) throw new Error('DB_UNAVAILABLE');
    const rows = await database`select 1 as ok`;
    if (rows[0]?.ok !== 1) throw new Error('DB_UNAVAILABLE');
  },
});

async function authorize(rpc: 'authorize_export_link' | 'authorize_export_generation', fields: RequestFields): Promise<Response> {
  return await fetch(endpoint + '/rest/v1/rpc/' + rpc, {
    method: 'POST',
    headers: { apikey: anonKey, Authorization: fields.authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_organization_id: fields.organizationId, p_job_id: fields.jobId }),
    signal: AbortSignal.timeout(5000),
  });
}

async function sign(request: Request, trace: Trace): Promise<Response> {
  try {
    const fields = await validatedFields(request, trace);
    if (!fields) return denied();
    trace.errorClass = 'FORBIDDEN';
    const result = await authorize('authorize_export_link', fields);
    if (!result.ok) { await result.body?.cancel(); return denied(); }
    const permit = await result.json();
    const path = permit?.path;
    const seconds = permit?.expires_in;
    trace.errorClass = 'INVALID_RESPONSE';
    if (path !== `${fields.organizationId}/${fields.jobId}.zip` ||
      !Number.isInteger(seconds) || seconds < 1 || seconds > 300) return denied();

    trace.errorClass = 'STORAGE_ERROR';
    const signed = await fetch(endpoint + '/storage/v1/object/sign/fichaje-evidence/' + path, {
      method: 'POST',
      headers: { apikey: storageKey, Authorization: 'Bearer ' + storageKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: seconds }), signal: AbortSignal.timeout(5000),
    });
    if (!signed.ok) { await signed.body?.cancel(); return unavailable(); }
    const receipt = await signed.json();
    if (typeof receipt.signedURL !== 'string' || !receipt.signedURL.startsWith('/object/sign/')) return unavailable();
    trace.outcome = 'success';
    trace.errorClass = 'NONE';
    return new Response(JSON.stringify({ url: endpoint + '/storage/v1' + receipt.signedURL, expires_in: seconds }), { headers: JSON_HEADERS });
  } catch {
    if (trace.errorClass !== 'INVALID_INPUT') {
      trace.outcome = 'failure';
      if (trace.errorClass === 'UNAUTHENTICATED') trace.errorClass = 'AUTH_UNAVAILABLE';
      else if (trace.errorClass === 'FORBIDDEN') trace.errorClass = 'UPSTREAM_5XX';
    }
    return unavailable();
  }
}

async function generate(request: Request, trace: Trace): Promise<Response> {
  let objectPath: string | null = null;
  let uploaded = false;
  try {
    const fields = await validatedFields(request, trace);
    if (!fields) return denied();

    trace.errorClass = 'FORBIDDEN';
    const result = await authorize('authorize_export_generation', fields);
    if (!result.ok) { await result.body?.cancel(); return denied(); }
    const permit = await result.json();
    if (permit?.status === 'READY') {
      trace.outcome = 'success';
      trace.errorClass = 'NONE';
      return new Response(JSON.stringify({ status: 'READY' }), { headers: JSON_HEADERS });
    }
    if (permit?.status !== 'PENDING') return denied();
    if (!database) { trace.errorClass = 'DB_UNAVAILABLE'; return unavailable(); }

    objectPath = `${fields.organizationId}/${fields.jobId}.zip`;
    trace.errorClass = 'DB_UNAVAILABLE';
    const status = await database.begin(async (sql) => {
      await sql`set local role fichaje_export_worker`;
      const jobs = await sql`
        select organization_id,id,status,snapshot
        from private.export_jobs
        where organization_id=${fields.organizationId}::uuid and id=${fields.jobId}::uuid
          and status in ('PENDING','READY') and expires_at>clock_timestamp()
        for update
      `;
      if (jobs.length !== 1) throw new Error('EXPORT_UNAVAILABLE');
      if (jobs[0].status === 'READY') return 'READY';

      trace.errorClass = 'INTERNAL';
      const { archive, digest: checksum } = await packageSnapshot(jobs[0].snapshot as EvidenceSnapshot);
      trace.errorClass = 'STORAGE_ERROR';
      await storage('POST', objectPath as string, archive);
      uploaded = true;
      const downloaded = await storage('GET', objectPath as string);
      if (await digest(downloaded) !== checksum) throw new Error('EXPORT_VERIFY_FAILED');

      trace.errorClass = 'DB_UNAVAILABLE';
      const updated = await sql`
        update private.export_jobs set status='READY',checksum=${checksum},object_path=${objectPath}
        where organization_id=${fields.organizationId}::uuid and id=${fields.jobId}::uuid
          and status='PENDING' and expires_at>clock_timestamp()
        returning id
      `;
      if (updated.length !== 1) throw new Error('EXPORT_EXPIRED');
      return 'READY';
    });

    if (status !== 'READY') return unavailable();
    trace.outcome = 'success';
    trace.errorClass = 'NONE';
    return new Response(JSON.stringify({ status: 'READY' }), { headers: JSON_HEADERS });
  } catch {
    if (uploaded && objectPath) {
      try { await storage('DELETE', objectPath); } catch { /* private orphan cleanup is best effort */ }
    }
    trace.outcome = 'failure';
    return unavailable();
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
  const generation = /\/generate\/?$/.test(new URL(request.url).pathname);
  const response = generation ? await generate(request, trace) : await sign(request, trace);
  opsEvent('export-link', 'export.link', trace.outcome, {
    error_class: trace.errorClass, duration_ms: performance.now() - started,
    status: response.status, stage: generation ? 'generate' : 'sign',
  });
  return response;
}

if (import.meta.main) {
  if (listenPort) Deno.serve({ hostname: '127.0.0.1', port: Number(listenPort), onListen: () => {} }, handler);
  else Deno.serve(handler);
}

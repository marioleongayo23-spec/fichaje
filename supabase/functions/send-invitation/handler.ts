import { renderInviteEmail } from './email.ts';

// Zero-trust transport: the caller's Supabase Auth JWT is verified by Auth and
// then forwarded unchanged to the existing create_invitation RPC, which alone
// authorizes the actor, organization, email and role. No service-role key used.
type GetEnv = (name: string) => string | undefined;
type Fetcher = typeof fetch;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]{64}$/;
const BODY_LIMIT = 1536;
const REPLY_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store, max-age=0',
  'Pragma': 'no-cache',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const reply = (status: number, error: string, headers: Record<string,string> = {}) =>
  new Response(JSON.stringify({ error }), { status, headers: { ...REPLY_HEADERS, ...headers } });
const cleanOrigin = (value: string | undefined): string | null => {
  if (!value) return null;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && u.origin === value.replace(/\\/$/, '') && !u.username && !u.password && u.pathname === '/' ? u.origin : null;
  } catch { return null; }
};
const validEmail = (email: unknown): email is string => typeof email === 'string' && email.length <= 254 &&
  /^[^\\s@<>]+@[^\\s@<>]+\\.[^\\s@<>]+$/.test(email) && email === email.trim().toLowerCase();

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      count += value.byteLength;
      if (count > BODY_LIMIT) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const body = new Uint8Array(count);
    let pos = 0;
    for (const c of chunks) { body.set(c, pos); pos += c.length; }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : null;
  } catch { return null; }
}

export async function handleInvitation(request: Request, env: GetEnv, http: Fetcher = fetch): Promise<Response> {
  const origin = cleanOrigin(env('BUNDY_APP_ORIGIN'));
  const corsOrigin = request.headers.get('origin');
  if (!origin) return reply(503, 'MAIL_NOT_CONFIGURED');
  if (corsOrigin !== origin) return reply(403, 'ORIGIN_FORBIDDEN');
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, content-type',
    'Vary': 'Origin',
  };
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...REPLY_HEADERS, ...cors } });
  if (request.method !== 'POST') return reply(405, 'METHOD_NOT_ALLOWED', cors);
  if (env('BUNDY_INVITES_ENABLED') !== '1') return reply(503, 'MAIL_NOT_CONFIGURED', cors);
  const supabaseUrl = cleanOrigin(env('SUPABASE_URL'));
  const anon = env('SUPABASE_ANON_KEY');
  const key = env('RESEND_API_KEY');
  const from = env('BUNDY_MAIL_FROM');
  if (!supabaseUrl || !anon || !key || !validEmail(from)) return reply(503, 'MAIL_NOT_CONFIGURED', cors);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415, 'UNSUPPORTED_MEDIA_TYPE', cors);
  if (Number(request.headers.get('content-length') || 0) > BODY_LIMIT) return reply(413, 'PAYLOAD_TOO_LARGE', cors);
  const body = await readJson(request);
  if (!body || Object.keys(body).sort().join(',') !== 'email,organization_id,request_id,role,token'
    || !UUID.test(String(body.organization_id)) || !UUID.test(String(body.request_id))
    || !validEmail(body.email) || !HEX.test(String(body.token)) || (body.role !== 'ADMIN' && body.role !== 'EMPLOYEE')) {
    return reply(400, 'INVALID_INPUT', cors);
  }
  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer [^\\s]+$/.test(authorization)) return reply(401, 'UNAUTHENTICATED', cors);
  const organizationId = String(body.organization_id);
  const requestId = String(body.request_id);
  const token = String(body.token);
  try {
    // An Auth-verified account is required before inviting anyone.
    const auth = await http(supabaseUrl + '/auth/v1/user', {
      headers: { apikey: anon, Authorization: authorization },
      signal: AbortSignal.timeout(5000),
    });
    if (!auth.ok) { await auth.body?.cancel(); return reply(401, 'UNAUTHENTICATED', cors); }
    const user = await auth.json() as { id?: string; email_confirmed_at?: string | null };
    if (!UUID.test(user.id || '') || !user.email_confirmed_at) return reply(403, 'FORBIDDEN', cors);

    const bytes = new TextEncoder().encode(token);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('');
    const created = await http(supabaseUrl + '/rest/v1/rpc/create_invitation', {
      method: 'POST',
      headers: { apikey: anon, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        p_organization_id: organizationId, p_request_id: requestId,
        p_email: body.email, p_role: body.role, p_token_hash: hash,
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!created.ok) {
      await created.body?.cancel();
      return reply(created.status === 401 ? 401 : 403, 'INVITATION_DENIED', cors);
    }
    await created.body?.cancel();

    // Organization is read only AFTER the authoritative RPC validated the actor.
    const org = await http(supabaseUrl + '/rest/v1/organizations?id=eq.' + organizationId + '&select=name', {
      headers: { apikey: anon, Authorization: authorization },
      signal: AbortSignal.timeout(5000),
    });
    let company = 'Tu empresa';
    if (org.ok) {
      const rows = await org.json() as Array<{ name?: string }>;
      if (Array.isArray(rows) && typeof rows[0]?.name === 'string') company = rows[0].name.slice(0, 200);
    } else await org.body?.cancel();

    const code = organizationId + '.' + token;
    const email = renderInviteEmail(origin, company, code);
    const sent = await http('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        'Idempotency-Key': 'bundy-invite-' + organizationId + '-' + requestId,
      },
      body: JSON.stringify({
        from: 'Bundy <' + from + '>', to: [body.email], subject: email.subject,
        html: email.html, text: email.text,
      }),
      signal: AbortSignal.timeout(7000),
    });
    if (!sent.ok) {
      await sent.body?.cancel();
      return reply(502, 'DELIVERY_NOT_CONFIRMED', cors);
    }
    await sent.body?.cancel();
    return new Response(JSON.stringify({ status: 'accepted_for_delivery' }), { status: 200, headers: { ...REPLY_HEADERS, ...cors } });
  } catch {
    // The RPC may have committed or Resend accepted before a network failure.
    // The browser retains the same token/request_id for safe manual handover.
    return reply(502, 'DELIVERY_NOT_CONFIRMED', cors);
  }
}

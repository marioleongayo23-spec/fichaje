// Server-only signer. The service key is used solely after JWT and RPC checks.
const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) throw new Error('CONFIG_REQUIRED');
  return value;
};
const endpoint = required('SUPABASE_URL');
const anonKey = required('SUPABASE_ANON_KEY');
const storageKey = required('SUPABASE_SERVICE_ROLE_KEY');
const denied = () => new Response(JSON.stringify({ error: 'FORBIDDEN' }), {
  status: 403, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
    'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' },
});
const uuid = (v: unknown): v is string => typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);

export async function handler(request: Request): Promise<Response> {
  try {
    if (request.method !== 'POST' || !request.headers.get('content-type')?.startsWith('application/json')) return denied();
    if (Number(request.headers.get('content-length') || 0) > 1024) return denied();
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('Bearer ')) return denied();
    const body = await request.text();
    if (body.length > 1024) return denied();
    const params: unknown = JSON.parse(body);
    if (typeof params !== 'object' || !params) return denied();
    const fields = params as Record<string, unknown>;
    if (Object.keys(fields).sort().join(',') !== 'job_id,organization_id' ||
      !uuid(fields.organization_id) || !uuid(fields.job_id)) return denied();
    const auth = await fetch(endpoint + '/auth/v1/user', { headers: { apikey: anonKey, Authorization: authorization }, signal: AbortSignal.timeout(5000) });
    if (!auth.ok) return denied();
    const result = await fetch(endpoint + '/rest/v1/rpc/authorize_export_link', {
      method: 'POST', headers: { apikey: anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_organization_id: fields.organization_id, p_job_id: fields.job_id }),
      signal: AbortSignal.timeout(5000),
    });
    if (!result.ok) return denied();
    const permit = await result.json();
    const path = permit?.path;
    const seconds = permit?.expires_in;
    if (path !== `${fields.organization_id}/${fields.job_id}.zip` ||
      !Number.isInteger(seconds) || seconds < 1 || seconds > 300) return denied();
    const signed = await fetch(endpoint + '/storage/v1/object/sign/fichaje-evidence/' + path, {
      method: 'POST', headers: { apikey: storageKey, Authorization: 'Bearer ' + storageKey,
        'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: seconds }),
      signal: AbortSignal.timeout(5000),
    });
    if (!signed.ok) return denied();
    const receipt = await signed.json();
    if (typeof receipt.signedURL !== 'string' || !receipt.signedURL.startsWith('/object/sign/')) return denied();
    return new Response(JSON.stringify({ url: endpoint + '/storage/v1' + receipt.signedURL, expires_in: seconds }), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Pragma': 'no-cache', 'Referrer-Policy': 'no-referrer' },
    });
  } catch { return denied(); }
}

if (import.meta.main) Deno.serve(handler);

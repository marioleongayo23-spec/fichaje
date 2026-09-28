// H7 edge→function ingress contract: signature binding, window, rotation and policy.
import { decodeSecret, ingressPolicy, readBounded, routeOf, signIngress, verifyIngress } from './ingress.ts';

const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const secret = crypto.getRandomValues(new Uint8Array(32));
const other = crypto.getRandomValues(new Uint8Array(32));
const b64 = (v: Uint8Array) => btoa(String.fromCharCode(...v));
const body = new TextEncoder().encode('{"organization_id":"x"}');
const now = 1_790_000_000;

Deno.test('a signature is bound to method, function, route, exact body and a 60 s window', async () => {
  const header = await signIngress(secret, now, 'POST', 'kiosk', 'record', body);
  assert(/^v1\.\d+\.[0-9a-f]{64}$/.test(header), 'format');
  assert(await verifyIngress([secret], header, 'POST', 'kiosk', 'record', body, now), 'valid');
  assert(await verifyIngress([secret], header, 'POST', 'kiosk', 'record', body, now + 60), 'edge of window');
  assert(!await verifyIngress([secret], header, 'POST', 'kiosk', 'record', body, now + 61), 'expired');
  assert(!await verifyIngress([secret], header, 'POST', 'kiosk', 'record', body, now - 61), 'future');
  assert(!await verifyIngress([secret], header, 'GET', 'kiosk', 'record', body, now), 'method');
  assert(!await verifyIngress([secret], header, 'POST', 'export-link', 'record', body, now), 'component');
  assert(!await verifyIngress([secret], header, 'POST', 'kiosk', 'authenticate', body, now), 'route');
  assert(!await verifyIngress([secret], header, 'POST', 'kiosk', 'record', new TextEncoder().encode('{"organization_id":"y"}'), now), 'body');
  assert(!await verifyIngress([other], header, 'POST', 'kiosk', 'record', body, now), 'secret');
  for (const bad of [null, '', 'v1.x.y', header.replace(/.$/, (c) => (c === '0' ? '1' : '0')), header.toUpperCase(), 'v2' + header.slice(2)]) {
    assert(!await verifyIngress([secret], bad, 'POST', 'kiosk', 'record', body, now), 'malformed');
  }
  assert(!await verifyIngress([], header, 'POST', 'kiosk', 'record', body, now), 'no secret never verifies');
});

Deno.test('rotation accepts the previous secret only next to the current one', async () => {
  const old = await signIngress(other, now, 'GET', 'export-link', 'health/ready', new Uint8Array(0));
  assert(await verifyIngress([secret, other], old, 'GET', 'export-link', 'health/ready', new Uint8Array(0), now), 'previous accepted');
  const env = (values: Record<string, string>) => (k: string) => values[k];
  const policy = ingressPolicy(env({ FICHAJE_INGRESS_SECRET: b64(secret), FICHAJE_INGRESS_SECRET_PREVIOUS: b64(other) }), true);
  assert(policy.required && policy.secrets.length === 2, 'two secrets');
  const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return (e as Error).message === 'CONFIG_REQUIRED'; } };
  assert(throws(() => ingressPolicy(env({}), true)), 'platform without secret fails closed');
  assert(throws(() => ingressPolicy(env({ FICHAJE_ENV: 'staging' }), false)), 'staging without secret fails closed');
  assert(throws(() => ingressPolicy(env({ FICHAJE_ENV: 'production' }), false)), 'production without secret fails closed');
  assert(throws(() => ingressPolicy(env({ FICHAJE_INGRESS_SECRET_PREVIOUS: b64(other) }), false)), 'previous alone fails');
  assert(throws(() => ingressPolicy(env({ FICHAJE_ENV: 'prod' }), false)), 'unknown environment fails');
  assert(throws(() => ingressPolicy(env({ FICHAJE_INGRESS_SECRET: b64(new Uint8Array(31)) }), false)), 'short secret fails');
  assert(throws(() => decodeSecret('not base64!')), 'invalid base64 fails');
  const local = ingressPolicy(env({}), false);
  assert(!local.required && local.secrets.length === 0, 'local listener without secret keeps H4-H6 behaviour');
});

Deno.test('routes and bounded bodies are derived identically on both sides', async () => {
  assert(routeOf('kiosk', 'POST', '/functions/v1/kiosk/record') === 'record', 'kiosk route');
  assert(routeOf('kiosk', 'POST', '/kiosk/authenticate/') === 'authenticate', 'trailing slash');
  assert(routeOf('kiosk', 'GET', '/functions/v1/kiosk/health/ready') === 'health/ready', 'health');
  assert(routeOf('export-link', 'POST', '/functions/v1/export-link') === 'sign', 'signer');
  assert(routeOf('export-link', 'PUT', '/export-link') === 'invalid', 'signer method');
  const small = await readBounded(new Request('http://x/', { method: 'POST', body: 'a'.repeat(1024) }), 1024);
  assert(small?.length === 1024, 'at limit');
  assert(await readBounded(new Request('http://x/', { method: 'POST', body: 'a'.repeat(1025) }), 1024) === null, 'over limit');
});

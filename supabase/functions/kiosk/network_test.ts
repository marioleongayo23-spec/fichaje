import { networkIdentifier, normalizePeer } from './network.ts';
const peer = (hostname: string): Deno.NetAddr => ({ transport: 'tcp', hostname, port: 1 });
const assert = (value: boolean) => { if (!value) throw new Error('NETWORK_TEST_FAILED'); };
Deno.test('network normalization, tenant/key isolation and irreversible representation', async () => {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const a = await networkIdentifier(peer('192.0.2.17'),'tenant-a',secret);
  assert(a === await networkIdentifier(peer('::ffff:c000:211'),'TENANT-A',secret));
  assert(normalizePeer(peer('2001:0DB8:0:0:0:0:0:1')) === normalizePeer(peer('2001:db8::1')));
  assert(a !== await networkIdentifier(peer('192.0.2.17'),'tenant-b',secret));
  assert(a !== await networkIdentifier(peer('192.0.2.18'),'tenant-a',secret));
  assert(a !== await networkIdentifier(peer('192.0.2.17'),'tenant-a',crypto.getRandomValues(new Uint8Array(32))));
  assert(/^[0-9a-f]{64}$/.test(a) && !a.includes('192.0.2.17'));
});
Deno.test('missing, non-IP and unsupported transport fail closed', () => {
  for (const host of ['', 'client.example', '127.1', '010.0.0.1', '::1%eth0', '::1]:123', '999.0.0.1']) {
    let denied = false; try { normalizePeer(peer(host)); } catch { denied = true; } assert(denied);
  }
  let denied = false; try { normalizePeer({ transport: 'unix', path: '/synthetic' }); } catch { denied = true; } assert(denied);
});

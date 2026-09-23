
// Only Deno's socket metadata is accepted, never Request headers or JSON.
export function normalizePeer(peer: Deno.Addr): string {
  if (peer.transport !== 'tcp') throw new Error('AUTH_FAILED');
  const host = peer.hostname;
  if (/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(host) && host.split('.').every(x => Number(x) <= 255)) return host;
  if (!host.includes(':') || !/^[0-9a-fA-F:.]+$/.test(host)) throw new Error('AUTH_FAILED');
  const canonical = new URL(`http://[${host}]/`).hostname.slice(1,-1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (mapped) {
    const a = parseInt(mapped[1],16), b = parseInt(mapped[2],16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return canonical;
}
export async function networkIdentifier(peer: Deno.Addr, tenant: string, secret: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw',secret,{ name: 'HMAC', hash: 'SHA-256' },false,['sign']);
  const bytes = new TextEncoder().encode(`kiosk-network-v1\n${tenant.toLowerCase()}\n${normalizePeer(peer)}`);
  try {
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC',key,bytes));
    return Array.from(digest,b => b.toString(16).padStart(2,'0')).join('');
  } finally { bytes.fill(0); }
}

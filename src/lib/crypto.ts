// Delivery of kiosk credentials/PINs: the gateway encrypts to a public key
// generated here; the private key is non-extractable and lives only in memory.
export interface DeliveryKeys { publicJwk: JsonWebKey; privateKey: CryptoKey }

export async function createDeliveryKeys(): Promise<DeliveryKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    false, ['encrypt', 'decrypt'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const publicJwk: JsonWebKey = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg, ext: true, key_ops: ['encrypt'] };
  return { publicJwk, privateKey: pair.privateKey };
}

export async function openDelivery(privateKey: CryptoKey, ciphertext: string): Promise<string> {
  const bytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, bytes);
  return new TextDecoder().decode(plain);
}

export function randomHex(bytes = 32): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

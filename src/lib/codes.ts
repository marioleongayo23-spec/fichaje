// One-time codes handed out of band. Parsed strictly; never placed in URLs.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function encodeInvitation(organizationId: string, token: string): string {
  return `${organizationId}.${token}`;
}
export function parseInvitation(code: string): { organizationId: string; token: string } | null {
  const match = new RegExp(`^(${UUID})\\.([0-9a-f]{64})$`, 'i').exec(code.trim());
  return match ? { organizationId: match[1].toLowerCase(), token: match[2].toLowerCase() } : null;
}

// Device setup code: tenant, device and the technical Auth credential the H4
// gateway generated. Only kiosk technical identities (.invalid domain) accepted.
export interface DeviceSetup { organizationId: string; deviceId: string; email: string; password: string }
const PREFIX = 'KIOSCO1.';

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(value: string): string {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeDeviceSetup(setup: DeviceSetup): string {
  return PREFIX + toBase64Url(JSON.stringify({ o: setup.organizationId, d: setup.deviceId, e: setup.email, p: setup.password }));
}
export function parseDeviceSetup(code: string): DeviceSetup | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX) || trimmed.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length)));
    if (!value || typeof value !== 'object') return null;
    const { o, d, e, p, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length || !isUuid(o) || !isUuid(d) || typeof e !== 'string' || typeof p !== 'string') return null;
    if (!new RegExp(`^${UUID}@kiosk\\.invalid$`, 'i').test(e) || p.length < 16 || p.length > 200) return null;
    return { organizationId: o.toLowerCase(), deviceId: d.toLowerCase(), email: e.toLowerCase(), password: p };
  } catch {
    return null;
  }
}

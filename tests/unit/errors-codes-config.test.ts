import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../vite.config';
import { readAppConfig, readEndpoint } from '../../src/config';
import { encodeDeviceSetup, encodeInvitation, parseDeviceSetup, parseInvitation } from '../../src/lib/codes';
import { ApiError, asApiError, errorMessage, toApiError } from '../../src/lib/errors';

describe('error mapping never exposes backend internals', () => {
  it('classifies stable backend codes', () => {
    expect(toApiError(409, { message: 'VERSION_CONFLICT', code: '40001' })).toMatchObject({ kind: 'conflict', code: 'VERSION_CONFLICT' });
    expect(toApiError(400, { message: 'POLICY_REQUIRED', code: '22023' })).toMatchObject({ kind: 'validation', code: 'POLICY_REQUIRED' });
    expect(toApiError(403, { message: 'FORBIDDEN', code: '42501' })).toMatchObject({ kind: 'forbidden' });
    expect(toApiError(403, { error: 'AUTH_FAILED' })).toMatchObject({ kind: 'forbidden' });
    expect(toApiError(401, { message: 'JWT expired', code: 'PGRST303' })).toMatchObject({ kind: 'unauthenticated' });
    expect(toApiError(503, { error: 'RETRYABLE_TIMEOUT' })).toMatchObject({ kind: 'busy' });
    expect(toApiError(500, { message: 'lock timeout', code: '55P03' })).toMatchObject({ kind: 'busy' });
    expect(toApiError(0, { message: 'TimeoutError: signal timed out' })).toMatchObject({ kind: 'timeout' });
    expect(toApiError(0, { message: 'TypeError: Failed to fetch' })).toMatchObject({ kind: 'network' });
    expect(toApiError(502, null)).toMatchObject({ kind: 'server', status: 502 });
  });
  it('shows only curated Spanish text', () => {
    const raw = toApiError(500, { message: 'relation "private.kiosk_credentials" does not exist', details: 'SELECT * FROM ...', hint: 'uuid 1f0e...' });
    expect(errorMessage(raw)).toBe('Se ha producido un error en el servicio. Inténtalo de nuevo más tarde.');
    expect(errorMessage(toApiError(400, { message: 'INVALID_TIMELINE' }))).toMatch(/orden imposible/);
    expect(errorMessage(new TypeError('Failed to fetch'))).toMatch(/No hay conexión/);
    expect(asApiError(new DOMException('x', 'TimeoutError'))).toBeInstanceOf(ApiError);
  });
});

describe('out-of-band codes', () => {
  const org = '5f2b3c4d-1111-4222-8333-944455556666';
  it('round-trips invitation codes and rejects malformed ones', () => {
    const token = 'a'.repeat(64);
    expect(parseInvitation(` ${encodeInvitation(org, token)} `)).toEqual({ organizationId: org, token });
    expect(parseInvitation(`${org}.${'a'.repeat(63)}`)).toBeNull();
    expect(parseInvitation('https://example.com/?token=x')).toBeNull();
  });
  it('accepts only kiosk technical identities in device setup codes', () => {
    const setup = { organizationId: org, deviceId: '6f2b3c4d-1111-4222-8333-944455556666', email: '7f2b3c4d-1111-4222-8333-944455556666@kiosk.invalid', password: 'x'.repeat(44) };
    expect(parseDeviceSetup(encodeDeviceSetup(setup))).toEqual(setup);
    expect(parseDeviceSetup(encodeDeviceSetup({ ...setup, email: 'persona@empresa.es' }))).toBeNull();
    expect(parseDeviceSetup(encodeDeviceSetup({ ...setup, deviceId: 'not-a-uuid' }))).toBeNull();
    expect(parseDeviceSetup('KIOSCO1.%%%')).toBeNull();
  });
});

describe('public configuration', () => {
  const env = { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic' };
  it('defaults server-only functions to same-origin paths', () => {
    expect(readAppConfig(env)).toMatchObject({
      kioskGatewayUrl: '/gateway/kiosk', exportLinkUrl: '/gateway/export-link',
      billingGatewayUrl: '/gateway/billing', billingEnabled: false,
    });
  });
  it.each(['http://evil.example.com/x', 'https://user:pw@example.com/x', 'https://example.com/x?token=1', '/../x', '//evil.example.com'])('rejects unsafe endpoint %s', (value) => {
    expect(() => readEndpoint(value, '/gateway/kiosk')).toThrow();
  });
  it('builds a strict CSP limited to the configured origins', () => {
    const csp = contentSecurityPolicy(env);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self' https://example.supabase.co");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });
});

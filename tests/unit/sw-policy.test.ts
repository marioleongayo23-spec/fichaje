import { describe, expect, it } from 'vitest';
import { classifyRequest, isShellCache } from '../../src/pwa/policy';

const origin = 'https://fichaje.example';
const precache = new Set(['/', '/assets/index-abc.js', '/manifest.webmanifest']);
const get = (url: string, extra: Partial<{ method: string; mode: string; headers: string[] }> = {}) => ({
  method: extra.method ?? 'GET', url, mode: extra.mode ?? 'cors',
  headers: { has: (name: string) => (extra.headers ?? []).includes(name) },
});

describe('service worker cache policy (PWA-02)', () => {
  it('serves navigations and precached shell assets only', () => {
    expect(classifyRequest(get(`${origin}/registro`, { mode: 'navigate' }), origin, precache)).toBe('navigate');
    expect(classifyRequest(get(`${origin}/assets/index-abc.js`), origin, precache)).toBe('asset');
    expect(classifyRequest(get(`${origin}/assets/other.js`), origin, precache)).toBeNull();
  });
  it.each([
    'https://project.supabase.co/rest/v1/rpc/record_time_event',
    'https://project.supabase.co/auth/v1/token?grant_type=password',
    'https://project.supabase.co/storage/v1/object/sign/fichaje-evidence/x.zip?token=abc',
    `${origin}/rest/v1/employees`, `${origin}/auth/v1/user`, `${origin}/functions/v1/kiosk/authenticate`,
    `${origin}/gateway/kiosk/record`, `${origin}/gateway/export-link`, `${origin}/storage/v1/object/x`,
    `${origin}/assets/index-abc.js?token=x`,
  ])('never handles %s', (url) => {
    expect(classifyRequest(get(url), origin, precache)).toBeNull();
    expect(classifyRequest(get(url, { mode: 'navigate' }), origin, precache)).toBeNull();
  });
  it('ignores non-GET and authenticated requests', () => {
    expect(classifyRequest(get(`${origin}/`, { method: 'POST', mode: 'navigate' }), origin, precache)).toBeNull();
    expect(classifyRequest(get(`${origin}/assets/index-abc.js`, { headers: ['authorization'] }), origin, precache)).toBeNull();
    expect(classifyRequest(get(`${origin}/assets/index-abc.js`, { headers: ['apikey'] }), origin, precache)).toBeNull();
  });
  it('only manages its own caches', () => {
    expect(isShellCache('fichaje-shell-abc')).toBe(true);
    expect(isShellCache('supabase-cache')).toBe(false);
  });
});

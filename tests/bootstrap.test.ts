import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { App } from '../src/App';
import {
  PRODUCTION_SUPABASE_ORIGIN,
  STAGING_SUPABASE_ORIGIN,
  readAppConfig,
} from '../src/config';
import { createSupabaseClient, readSupabaseConfig } from '../src/lib/supabase';

const key = 'sb_publishable_synthetic_test_only';
describe('bootstrap without backend', () => {
  it('renders with no environment or backend', () => {
    expect(renderToStaticMarkup(createElement(App))).toContain('Sin servicio de fichaje activo');
    expect(createSupabaseClient({})).toBeNull();
  });
  it('accepts public configuration and constructs a lazy client', () => {
    const env = { VITE_SUPABASE_URL: 'https://example.supabase.co', VITE_SUPABASE_PUBLISHABLE_KEY: key };
    expect(readSupabaseConfig(env)).toEqual({ url: env.VITE_SUPABASE_URL, key });
    expect(createSupabaseClient(env)).not.toBeNull();
  });
  it('permits loopback for future local Supabase', () => {
    expect(readSupabaseConfig({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: key })).not.toBeNull();
  });
  it.each([
    { VITE_SUPABASE_URL: 'https://example.supabase.co' },
    { VITE_SUPABASE_PUBLISHABLE_KEY: key },
  ])('rejects partial configuration', (env) => expect(() => readSupabaseConfig(env)).toThrow());
  it.each(['garbage', 'http://example.com', 'ftp://localhost', 'https://user:pass@example.com', 'https://example.com?token=x', 'https://example.com/path'])('rejects unsafe URL %s', (url) => {
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: url, VITE_SUPABASE_PUBLISHABLE_KEY: key })).toThrow();
  });
  it.each(['sb_secret_synthetic', 'eyJhbGciOiJIUzI1NiJ9.synthetic', 'arbitrary'])('rejects private or unsupported key format', (invalid) => {
    expect(() => readSupabaseConfig({ VITE_SUPABASE_URL: 'https://example.com', VITE_SUPABASE_PUBLISHABLE_KEY: invalid })).toThrow();
  });
});

describe('go-live deployment binding', () => {
  it('pins staging builds to the staging Supabase project', () => {
    expect(readAppConfig({
      VITE_DEPLOYMENT_TIER: 'staging',
      VITE_SUPABASE_URL: STAGING_SUPABASE_ORIGIN,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    })?.supabase.url).toBe(STAGING_SUPABASE_ORIGIN);
    expect(() => readAppConfig({
      VITE_DEPLOYMENT_TIER: 'staging',
      VITE_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    })).toThrow(/different Supabase project/);
  });

  it('pins production builds to the production Supabase project', () => {
    expect(readAppConfig({
      VITE_DEPLOYMENT_TIER: 'production',
      VITE_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    })?.supabase.url).toBe(PRODUCTION_SUPABASE_ORIGIN);
    expect(() => readAppConfig({
      VITE_DEPLOYMENT_TIER: 'production',
      VITE_SUPABASE_URL: STAGING_SUPABASE_ORIGIN,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
    })).toThrow(/different Supabase project/);
  });

  it('requires same-origin gateway paths in production', () => {
    expect(() => readAppConfig({
      VITE_DEPLOYMENT_TIER: 'production',
      VITE_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
      VITE_KIOSK_GATEWAY_URL: 'https://example.com/kiosk',
    })).toThrow(/same-origin/);
    expect(readAppConfig({
      VITE_DEPLOYMENT_TIER: 'production',
      VITE_SUPABASE_URL: PRODUCTION_SUPABASE_ORIGIN,
      VITE_SUPABASE_PUBLISHABLE_KEY: key,
      VITE_KIOSK_GATEWAY_URL: '/gateway/kiosk',
      VITE_EXPORT_LINK_URL: '/gateway/export-link',
    })).not.toBeNull();
  });
});

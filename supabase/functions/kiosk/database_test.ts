import { databaseTls } from './database.ts';

const assert = (condition: unknown, label: string) => { if (!condition) throw new Error(label); };
const throwsConfig = (fn: () => unknown) => {
  try { fn(); return false; } catch (error) { return (error as Error).message === 'CONFIG_REQUIRED'; }
};
const ca = '-----BEGIN CERTIFICATE-----\nsynthetic-test-ca\n-----END CERTIFICATE-----';

Deno.test('remote kiosk database requires verify-full plus explicit CA', () => {
  const tls = databaseTls('postgresql://gateway:secret@db.example.invalid:5432/postgres?sslmode=verify-full', ca, 'production');
  assert(tls !== false && tls.rejectUnauthorized === true && tls.ca === ca, 'strict TLS options');
  assert(throwsConfig(() => databaseTls('postgresql://gateway:secret@db.example.invalid:5432/postgres?sslmode=verify-full', undefined, 'production')), 'missing CA fails');
  assert(throwsConfig(() => databaseTls('postgresql://gateway:secret@db.example.invalid:5432/postgres?sslmode=require', ca, 'production')), 'weak production TLS fails');
  assert(throwsConfig(() => databaseTls('postgresql://gateway:secret@db.example.invalid:5432/postgres', ca, 'staging')), 'staging also fails closed');
  assert(throwsConfig(() => databaseTls('not-a-url', ca, 'production')), 'invalid DSN fails');
});

Deno.test('local CI database keeps the existing non-TLS loopback path', () => {
  assert(databaseTls('postgres://kiosk_ci:secret@127.0.0.1:54322/postgres', undefined, 'ci') === false, 'local HTTP-era integration unchanged');
});

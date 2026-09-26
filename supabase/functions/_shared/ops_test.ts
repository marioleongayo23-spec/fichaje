// OPS-02 Deno tests: allowlisted events, contract consistency, readiness and
// health responses of the server-only functions.
// deno test --allow-read --allow-env=FICHAJE_RELEASE,FICHAJE_COMMIT supabase/functions/_shared/ops_test.ts
import { buildEvent, classifySql, COMPONENTS, ERROR_CLASSES, healthHandler, OPERATIONS, readiness } from './ops.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const contract = JSON.parse(await Deno.readTextFile(new URL('../../../ops/contract.json', import.meta.url)));

Deno.test('gateway vocabulary is a subset of ops/contract.json', () => {
  for (const c of COMPONENTS) assert(contract.components.includes(c), c);
  for (const o of OPERATIONS) assert(contract.operations.includes(o), o);
  for (const e of ERROR_CLASSES) assert(contract.error_classes.includes(e), e);
});

Deno.test('events carry only allowlisted fields and never payload data', () => {
  const event = buildEvent('kiosk-gateway', 'clock.CLOCK_IN', 'rejected', {
    error_class: 'VERSION_CONFLICT', request_id: '3F2B8A54-6C1D-4E8F-9A0B-1C2D3E4F5A6B', stage: 'database', duration_ms: 301.23456, status: 409,
    ...({ pin: '12345678', challenge: 'a'.repeat(64), email: 'x@example.invalid', sql: 'select 1' } as Record<string, unknown>),
  });
  const keys = Object.keys(event).sort();
  assert(JSON.stringify(keys) === JSON.stringify(['commit', 'component', 'duration_ms', 'error_class', 'level', 'operation', 'outcome', 'release', 'request_id', 'stage', 'status', 'ts']), keys.join());
  assert(event.request_id === '3f2b8a54-6c1d-4e8f-9a0b-1c2d3e4f5a6b' && event.duration_ms === 301.235, 'normalized');
  for (const key of contract.required_event_fields) assert(key in event, key);
  const text = JSON.stringify(event);
  assert(!/12345678|example\.invalid|select 1|aaaaaaaa/.test(text), 'no sensitive values');
  const invalid = buildEvent('export-link', 'export.link', 'failure', { request_id: 'not-a-uuid', stage: 'SELECT *', status: 42 });
  assert(!('request_id' in invalid) && !('stage' in invalid) && !('status' in invalid) && invalid.error_class === 'INTERNAL', 'invalid values dropped');
  let threw = false;
  try { buildEvent('kiosk-gateway', 'employee.lookup' as never, 'success'); } catch { threw = true; }
  assert(threw, 'unknown operation is a programming error');
});

Deno.test('SQL errors map to stable classes without reading driver text', () => {
  assert(classifySql(Object.assign(new Error('VERSION_CONFLICT'), { code: '40001' })).errorClass === 'VERSION_CONFLICT', 'conflict');
  assert(classifySql(Object.assign(new Error('permission denied for table x'), { code: '42501' })).errorClass === 'FORBIDDEN', 'forbidden');
  assert(classifySql(Object.assign(new Error('canceling statement'), { code: '57014' })).errorClass === 'RETRYABLE_TIMEOUT', 'timeout');
  assert(classifySql(Object.assign(new Error('duplicate key (pin)=(1)'), { code: '23505' })).errorClass === 'INTERNAL', 'unknown');
  assert(classifySql(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })).errorClass === 'DB_UNAVAILABLE', 'db down');
});

Deno.test('readiness distinguishes UP, DEGRADED and DOWN', async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  assert((await readiness({ a: async () => {}, b: async () => {} })).status === 'UP', 'up');
  assert((await readiness({ a: async () => { await sleep(30); } }, 10, 500)).status === 'DEGRADED', 'degraded');
  const down = await readiness({ a: async () => {}, b: async () => { throw new Error('boom'); } });
  assert(down.status === 'DOWN' && down.checks.b === 'DOWN' && down.checks.a === 'UP', 'down');
  assert((await readiness({ a: async () => { await sleep(100); } }, 10, 20)).status === 'DOWN', 'timeout counts as DOWN');
  await sleep(120);
});

Deno.test('health responses expose statuses only and are cached', async () => {
  let calls = 0;
  const original = console.log;
  const lines: string[] = [];
  console.log = (line: string) => { lines.push(line); };
  try {
    const health = healthHandler('kiosk-gateway', { database: async () => { calls++; throw new Error('secret connection string'); } }, 60_000);
    const live = await health('/functions/v1/kiosk/health/live');
    assert(live?.status === 200 && JSON.stringify(await live.json()) === '{"status":"UP"}', 'live');
    const ready = await health('/health/ready');
    assert(ready?.status === 503 && ready.headers.get('Cache-Control')?.includes('no-store'), 'ready down');
    const body = await ready.json();
    assert(JSON.stringify(body) === '{"status":"DOWN","checks":{"database":"DOWN"}}', 'no details');
    await (await health('/health/ready'))?.body?.cancel();
    assert(calls === 1, 'probe result cached');
    assert(await health('/record') === null, 'other paths untouched');
    assert(lines.length === 3 && lines.every((l) => !l.includes('secret')), 'events carry no probe error text');
  } finally {
    console.log = original;
  }
});

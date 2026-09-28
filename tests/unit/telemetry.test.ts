import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { releaseId, withReleaseMeta } from '../../vite.config';
import { postJson, rpc } from '../../src/lib/api';
import { ApiError } from '../../src/lib/errors';
import {
  BUCKETS_MS, CLIENT_ERROR_CLASSES, CLIENT_OPERATIONS, CLIENT_OUTCOMES, MAX_DURATION_MS, flush, operationFor, outcomeOf, recordRequest, takeBatch,
} from '../../src/lib/telemetry';

const contract = JSON.parse(readFileSync('ops/contract.json', 'utf8'));
const migration = readFileSync('supabase/migrations/20260926000100_ops_observability.sql', 'utf8');

function fakeClient(result: { data?: unknown; error?: unknown; status?: number } | Error, session = true) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const builder = (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    const run = () => result instanceof Error ? Promise.reject(result) : Promise.resolve({ data: result.data ?? null, error: result.error ?? null, status: result.status ?? 200 });
    return { retry: () => ({ abortSignal: () => run() }) };
  };
  const client = { rpc: builder, auth: { getSession: async () => ({ data: { session: session ? { access_token: 'x' } : null } }) } };
  return { client: client as unknown as SupabaseClient, calls };
}

afterEach(() => { takeBatch(); vi.restoreAllMocks(); });

describe('OPS-02 client telemetry vocabulary', () => {
  it('matches the contract and the database ingestion vocabulary exactly', () => {
    expect([...CLIENT_OPERATIONS]).toEqual(contract.client_vocabulary.operations);
    expect([...CLIENT_OUTCOMES]).toEqual(contract.client_vocabulary.outcomes);
    expect([...CLIENT_ERROR_CLASSES]).toEqual(contract.client_vocabulary.error_classes);
    expect(BUCKETS_MS).toEqual(contract.duration_buckets_ms);
    for (const value of [...CLIENT_OPERATIONS, ...CLIENT_OUTCOMES, ...CLIENT_ERROR_CLASSES]) expect(migration).toContain(`'${value}'`);
  });
  it('maps RPC names and clock actions to bounded operations', () => {
    expect(operationFor('record_time_event', { p_action: 'BREAK_START', p_employee_id: 'e' })).toBe('clock.BREAK_START');
    expect(operationFor('record_time_event', { p_action: 'DROP TABLE' })).toBe('rpc.other');
    expect(operationFor('decide_correction')).toBe('rpc.decide_correction');
    expect(operationFor('some_new_rpc')).toBe('rpc.other');
  });
  it('classifies outcomes, including unknown outcomes of mutations', () => {
    expect(outcomeOf(null, true)).toEqual({ outcome: 'success', errorClass: 'NONE' });
    expect(outcomeOf(new ApiError('timeout', 'TIMEOUT'), true)).toEqual({ outcome: 'unknown', errorClass: 'TIMEOUT' });
    expect(outcomeOf(new ApiError('timeout', 'TIMEOUT'), false)).toEqual({ outcome: 'timeout', errorClass: 'TIMEOUT' });
    expect(outcomeOf(new ApiError('server', 'SERVER', 502), true)).toEqual({ outcome: 'unknown', errorClass: 'UPSTREAM_5XX' });
    expect(outcomeOf(new ApiError('conflict', 'VERSION_CONFLICT', 409), true)).toEqual({ outcome: 'rejected', errorClass: 'VERSION_CONFLICT' });
    expect(outcomeOf(new ApiError('validation', 'CLOCK_REGRESSION', 400), true)).toEqual({ outcome: 'rejected', errorClass: 'CLOCK_REGRESSION' });
    expect(outcomeOf(new ApiError('validation', 'POLICY_REQUIRED', 400), true)).toEqual({ outcome: 'rejected', errorClass: 'POLICY_REQUIRED' });
    expect(outcomeOf(new ApiError('busy', 'BUSY', 503), true)).toEqual({ outcome: 'failure', errorClass: 'RETRYABLE_TIMEOUT' });
  });
});

describe('OPS-02 client telemetry aggregation and delivery', () => {
  it('aggregates counters and latency buckets per operation, outcome and class', () => {
    recordRequest('clock.CLOCK_IN', null, true, 30);
    recordRequest('clock.CLOCK_IN', null, true, 120);
    recordRequest('clock.CLOCK_IN', new ApiError('conflict', 'VERSION_CONFLICT', 409), true, 40);
    const batch = takeBatch();
    const ok = batch.find((b) => b.outcome === 'success');
    expect(ok).toEqual({ operation: 'clock.CLOCK_IN', outcome: 'success', error_class: 'NONE', count: 2, sum_ms: 150, buckets: [1, 0, 1, 0, 0, 0, 0, 0, 0, 0] });
    expect(batch.find((b) => b.error_class === 'VERSION_CONFLICT')?.count).toBe(1);
    expect(takeBatch()).toEqual([]);
  });
  it('records real API calls without identities, arguments or URLs', async () => {
    const { client } = fakeClient({ data: { state: 'WORKING' } });
    await rpc(client, 'record_time_event', { p_organization_id: 'org-uuid', p_employee_id: 'employee-uuid', p_request_id: 'req-uuid', p_action: 'CLOCK_IN', p_expected_version: 0 });
    const failing = fakeClient({ error: { message: 'VERSION_CONFLICT', code: '40001' }, status: 409 });
    await expect(rpc(failing.client, 'record_time_event', { p_action: 'CLOCK_OUT' })).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    const lost = fakeClient(new DOMException('signal timed out', 'TimeoutError'));
    await expect(rpc(lost.client, 'record_time_event', { p_action: 'BREAK_END' })).rejects.toMatchObject({ kind: 'timeout' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"AUTH_FAILED"}', { status: 403 })));
    await expect(postJson('https://example.invalid/gateway/kiosk/authenticate', 'token', { code: 'EMP-7', pin: '12345678' }, 'kiosk.authenticate', false)).rejects.toBeInstanceOf(ApiError);
    vi.unstubAllGlobals();
    const batch = takeBatch();
    expect(batch.map((b) => [b.operation, b.outcome, b.error_class]).sort()).toEqual([
      ['clock.BREAK_END', 'unknown', 'TIMEOUT'], ['clock.CLOCK_IN', 'success', 'NONE'],
      ['clock.CLOCK_OUT', 'rejected', 'VERSION_CONFLICT'], ['kiosk.authenticate', 'rejected', 'FORBIDDEN']]);
    const text = JSON.stringify(batch);
    for (const secret of ['org-uuid', 'employee-uuid', 'req-uuid', 'EMP-7', '12345678', 'example.invalid', 'token']) expect(text).not.toContain(secret);
    for (const item of batch) expect(Object.keys(item).sort()).toEqual(['buckets', 'count', 'error_class', 'operation', 'outcome', 'sum_ms']);
  });
  it('flushes through the write-only RPC and keeps data when delivery fails', async () => {
    recordRequest('select', null, false, 10);
    const failed = fakeClient({ error: { message: 'boom' }, status: 500 });
    expect(await flush(failed.client)).toBe(false);
    const delivered = fakeClient({ data: { accepted: 1 } });
    expect(await flush(delivered.client)).toBe(true);
    expect(delivered.calls).toHaveLength(1);
    expect(delivered.calls[0].name).toBe('ops_ingest_client_metrics');
    expect(Object.keys(delivered.calls[0].args)).toEqual(['p_batch']);
    expect((delivered.calls[0].args.p_batch as { count: number }[])[0].count).toBe(1);
    expect(await flush(delivered.client)).toBe(true);
    expect(delivered.calls).toHaveLength(1);
    recordRequest('select', null, false, 10);
    const anonymous = fakeClient({ data: {} }, false);
    expect(await flush(anonymous.client)).toBe(false);
    expect(anonymous.calls).toHaveLength(0);
  });
  it('bounds series count and per-window counters', () => {
    for (let i = 0; i < 1500; i++) recordRequest('select', null, false, 1);
    expect(takeBatch()[0].count).toBe(1000);
  });
  it('keeps durations inside the server contract (+Inf capped at 120 s)', () => {
    recordRequest('select', null, false, 3_600_000);
    recordRequest('select', null, false, 45_000);
    expect(takeBatch()[0]).toMatchObject({ count: 2, sum_ms: MAX_DURATION_MS + 45_000, buckets: [0, 0, 0, 0, 0, 0, 0, 0, 0, 2] });
  });
  it('drops a batch the server rate-limits instead of retrying it', async () => {
    recordRequest('select', null, false, 10);
    const limited = fakeClient({ data: { accepted: 0, limited: true } });
    expect(await flush(limited.client)).toBe(true);
    expect(takeBatch()).toEqual([]);
  });
  it('never sends the release: it only marks the built index.html, bounded', () => {
    expect(releaseId('0.0.0+abc1234')).toBe('0.0.0+abc1234');
    expect(releaseId('ops@example.invalid')).toBe('dev');
    expect(releaseId(undefined)).toBe('dev');
    expect(withReleaseMeta('<head><meta charset="UTF-8" /></head>', '0.0.0+abc1234'))
      .toBe('<head><meta charset="UTF-8" />\n    <meta name="fichaje-release" content="0.0.0+abc1234" /></head>');
    expect(withReleaseMeta('<meta charset="UTF-8" />', '"><script>')).toContain('content="dev"');
    expect(readFileSync('src/lib/telemetry.ts', 'utf8')).not.toMatch(/p_release|__FICHAJE_RELEASE__|RELEASE\b/);
  });
});

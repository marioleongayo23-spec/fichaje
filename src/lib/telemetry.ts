import type { SupabaseClient } from '@supabase/supabase-js';
import type { ApiError } from './errors';

// OPS-02 client telemetry (OBS-02). Only aggregated counters and latency buckets
// per operation, outcome and stable error class leave the browser, through a
// write-only RPC. No tenant, person, record, request_id, URL or free text is
// kept or sent, and nothing is written to browser storage.
export const CLIENT_OPERATIONS = [
  'clock.CLOCK_IN', 'clock.BREAK_START', 'clock.BREAK_END', 'clock.CLOCK_OUT', 'kiosk.authenticate',
  'kiosk.clock.CLOCK_IN', 'kiosk.clock.BREAK_START', 'kiosk.clock.BREAK_END', 'kiosk.clock.CLOCK_OUT',
  'kiosk.provision', 'kiosk.revoke', 'kiosk.reset', 'export.link', 'auth.sign_in', 'select',
  'rpc.get_employee_state', 'rpc.get_effective_timeline', 'rpc.get_own_evidence', 'rpc.submit_correction',
  'rpc.decide_correction', 'rpc.request_export', 'rpc.manage_employee', 'rpc.manage_membership',
  'rpc.transfer_ownership', 'rpc.create_invitation', 'rpc.accept_invitation', 'rpc.create_work_policy',
  'rpc.assign_work_policy', 'rpc.classify_hours', 'rpc.record_evidence_delivery', 'rpc.authorize_export_link', 'rpc.other',
] as const;
export const CLIENT_OUTCOMES = ['success', 'failure', 'timeout', 'unknown', 'rejected'] as const;
export const CLIENT_ERROR_CLASSES = [
  'NONE', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'ALREADY_DECIDED', 'CLOCK_REGRESSION', 'POLICY_REQUIRED',
  'INVALID_TRANSITION', 'INVALID_INPUT', 'INVALID_TIMEZONE', 'INVALID_TIMELINE', 'INVALID_ORDINAL', 'FUTURE_TIME',
  'POLICY_BACKDATE', 'HOURS_MISMATCH', 'INCOMPLETE_PERIOD', 'LAST_OWNER', 'FORBIDDEN', 'UNAUTHENTICATED', 'AUTH_FAILED',
  'RATE_LIMITED', 'TIMEOUT', 'NETWORK', 'UPSTREAM_5XX', 'RETRYABLE_TIMEOUT', 'INVALID_RESPONSE',
] as const;
export type ClientOperation = typeof CLIENT_OPERATIONS[number];
export type ClientOutcome = typeof CLIENT_OUTCOMES[number];
export type ClientErrorClass = typeof CLIENT_ERROR_CLASSES[number];
// Upper bounds in ms; the tenth bucket is +Inf (same layout as ops/contract.json).
export const BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

const ACTIONS = ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'];
// A lost response of these may have committed: its outcome is unknown.
const MUTATIONS = new Set(['record_time_event', 'submit_correction', 'decide_correction', 'request_export', 'manage_employee',
  'manage_membership', 'transfer_ownership', 'create_invitation', 'accept_invitation', 'create_work_policy',
  'assign_work_policy', 'classify_hours', 'record_evidence_delivery']);
const MAX_SERIES = 100;
const FLUSH_MS = 60_000;

export interface SeriesBatchItem {
  operation: ClientOperation; outcome: ClientOutcome; error_class: ClientErrorClass;
  count: number; sum_ms: number; buckets: number[];
}
const series = new Map<string, SeriesBatchItem>();

export function operationFor(rpcName: string, args?: Record<string, unknown>): ClientOperation {
  if (rpcName === 'record_time_event' && typeof args?.p_action === 'string' && ACTIONS.includes(args.p_action)) {
    return `clock.${args.p_action}` as ClientOperation;
  }
  const name = `rpc.${rpcName}`;
  return (CLIENT_OPERATIONS as readonly string[]).includes(name) ? name as ClientOperation : 'rpc.other';
}

export function isMutation(rpcName: string): boolean {
  return MUTATIONS.has(rpcName);
}

export function outcomeOf(error: ApiError | null, mutation: boolean): { outcome: ClientOutcome; errorClass: ClientErrorClass } {
  if (!error) return { outcome: 'success', errorClass: 'NONE' };
  switch (error.kind) {
    case 'timeout': return { outcome: mutation ? 'unknown' : 'timeout', errorClass: 'TIMEOUT' };
    case 'network': return { outcome: mutation ? 'unknown' : 'failure', errorClass: 'NETWORK' };
    case 'server': return { outcome: mutation ? 'unknown' : 'failure', errorClass: error.code === 'INVALID_RESPONSE' ? 'INVALID_RESPONSE' : 'UPSTREAM_5XX' };
    case 'busy': return { outcome: 'failure', errorClass: 'RETRYABLE_TIMEOUT' };
    case 'unauthenticated': return { outcome: 'rejected', errorClass: 'UNAUTHENTICATED' };
    case 'forbidden': return { outcome: 'rejected', errorClass: 'FORBIDDEN' };
    default:
      return { outcome: 'rejected', errorClass: (CLIENT_ERROR_CLASSES as readonly string[]).includes(error.code) ? error.code as ClientErrorClass : 'INVALID_INPUT' };
  }
}

export function recordRequest(operation: ClientOperation, error: ApiError | null, mutation: boolean, durationMs: number): void {
  const { outcome, errorClass } = outcomeOf(error, mutation);
  const key = `${operation}|${outcome}|${errorClass}`;
  let item = series.get(key);
  if (!item) {
    if (series.size >= MAX_SERIES) return;
    item = { operation, outcome, error_class: errorClass, count: 0, sum_ms: 0, buckets: new Array(BUCKETS_MS.length + 1).fill(0) };
    series.set(key, item);
  }
  if (item.count >= 1000) return; // bounded per flush window (server limit)
  const ms = Math.max(0, Math.round(durationMs * 1000) / 1000);
  const index = BUCKETS_MS.findIndex((limit) => ms <= limit);
  item.buckets[index === -1 ? BUCKETS_MS.length : index] += 1;
  item.count += 1;
  item.sum_ms = Math.round((item.sum_ms + ms) * 1000) / 1000;
}

// Removes and returns the pending aggregates. Callers put them back if delivery fails.
export function takeBatch(): SeriesBatchItem[] {
  const batch = [...series.values()].filter((s) => s.count > 0);
  series.clear();
  return batch;
}

export function restoreBatch(batch: SeriesBatchItem[]): void {
  for (const item of batch) {
    const key = `${item.operation}|${item.outcome}|${item.error_class}`;
    const current = series.get(key);
    if (!current) {
      if (series.size < MAX_SERIES) series.set(key, item);
      continue;
    }
    if (current.count + item.count > 1000) continue;
    current.count += item.count;
    current.sum_ms = Math.round((current.sum_ms + item.sum_ms) * 1000) / 1000;
    current.buckets = current.buckets.map((value, i) => value + item.buckets[i]);
  }
}

declare const __FICHAJE_RELEASE__: string | undefined;
export const RELEASE = typeof __FICHAJE_RELEASE__ === 'string' && /^[0-9A-Za-z.+_-]{1,64}$/.test(__FICHAJE_RELEASE__) ? __FICHAJE_RELEASE__ : 'dev';

// Flushes through the authenticated session only; delivery never blocks the UI
// and its own outcome is not recorded (no feedback loop).
export async function flush(client: SupabaseClient): Promise<boolean> {
  const batch = takeBatch();
  if (!batch.length) return true;
  try {
    const { data } = await client.auth.getSession();
    if (!data.session) { restoreBatch(batch); return false; }
    const { error } = await client.rpc('ops_ingest_client_metrics', { p_release: RELEASE, p_batch: batch })
      .retry(false).abortSignal(AbortSignal.timeout(5000));
    if (error) { restoreBatch(batch); return false; }
    return true;
  } catch {
    restoreBatch(batch);
    return false;
  }
}

export function startTelemetry(client: SupabaseClient): () => void {
  const send = () => { void flush(client); };
  const onHide = () => { if (document.visibilityState === 'hidden') send(); };
  const timer = window.setInterval(send, FLUSH_MS);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', send);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', send);
  };
}

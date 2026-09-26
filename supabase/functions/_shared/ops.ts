// OPS-02 operational layer for the server-only functions (OBS-01/OBS-03).
// One JSON line per request built only from enumerated values of
// ops/contract.json: never bodies, JWT, PIN, challenges, IP, SQL text, emails
// or record identifiers (a request_id is the only correlation id).
export type Outcome = 'success' | 'failure' | 'timeout' | 'unknown' | 'rejected' | 'degraded' | 'skipped';
export type Status = 'UP' | 'DEGRADED' | 'DOWN';

export const COMPONENTS = ['kiosk-gateway', 'export-link'] as const;
export const OPERATIONS = ['clock.CLOCK_IN', 'clock.BREAK_START', 'clock.BREAK_END', 'clock.CLOCK_OUT', 'kiosk.authenticate',
  'kiosk.provision', 'kiosk.revoke', 'kiosk.reset', 'export.link', 'request.rejected', 'health.live', 'health.ready'] as const;
export const ERROR_CLASSES = ['NONE', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'CLOCK_REGRESSION', 'POLICY_REQUIRED',
  'INVALID_TRANSITION', 'INVALID_INPUT', 'FORBIDDEN', 'UNAUTHENTICATED', 'AUTH_FAILED', 'RATE_LIMITED', 'TIMEOUT', 'NETWORK',
  'UPSTREAM_5XX', 'RETRYABLE_TIMEOUT', 'INVALID_RESPONSE', 'DB_UNAVAILABLE', 'AUTH_UNAVAILABLE', 'STORAGE_ERROR', 'CONFIG',
  'DEGRADED', 'INTERNAL'] as const;
export type Component = typeof COMPONENTS[number];
export type Operation = typeof OPERATIONS[number];
export type ErrorClass = typeof ERROR_CLASSES[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z_]{1,32}$/;
const RELEASE = /^[0-9A-Za-z.+_-]{1,64}$/;
const COMMIT = /^([0-9a-f]{7,40}|unknown)$/;

export interface EventFields { request_id?: unknown; duration_ms?: number; error_class?: ErrorClass; stage?: string; status?: number }

function env(name: string, fallback: string): string {
  try { return Deno.env.get(name) ?? fallback; } catch { return fallback; }
}

export function releaseInfo(): { release: string; commit: string } {
  const release = env('FICHAJE_RELEASE', 'dev');
  const commit = env('FICHAJE_COMMIT', 'unknown').toLowerCase();
  return { release: RELEASE.test(release) ? release : 'invalid', commit: COMMIT.test(commit) ? commit : 'unknown' };
}

// Builds the allowlisted event. Unknown component/operation/outcome is a
// programming error: it throws instead of logging something unexpected.
export function buildEvent(component: Component, operation: Operation, outcome: Outcome, fields: EventFields = {}): Record<string, unknown> {
  if (!COMPONENTS.includes(component) || !OPERATIONS.includes(operation)) throw new Error('OPS_EVENT_CONTRACT');
  const { release, commit } = releaseInfo();
  const errorClass = fields.error_class && ERROR_CLASSES.includes(fields.error_class) ? fields.error_class : outcome === 'success' ? 'NONE' : 'INTERNAL';
  const event: Record<string, unknown> = {
    ts: new Date().toISOString(), level: outcome === 'failure' || outcome === 'unknown' ? 'error' : 'info',
    release, commit, component, operation, outcome, error_class: errorClass,
  };
  if (typeof fields.stage === 'string' && CODE.test(fields.stage)) event.stage = fields.stage;
  if (typeof fields.request_id === 'string' && UUID.test(fields.request_id)) event.request_id = fields.request_id.toLowerCase();
  if (typeof fields.duration_ms === 'number' && Number.isFinite(fields.duration_ms) && fields.duration_ms >= 0) {
    event.duration_ms = Math.round(fields.duration_ms * 1000) / 1000;
  }
  if (Number.isInteger(fields.status) && (fields.status as number) >= 100 && (fields.status as number) <= 599) event.status = fields.status;
  return event;
}

export function opsEvent(component: Component, operation: Operation, outcome: Outcome, fields: EventFields = {}): void {
  // stdout JSON line: collected by the platform log sink (Supabase/H7 decision).
  console.log(JSON.stringify(buildEvent(component, operation, outcome, fields)));
}

// PostgreSQL errors are classified by SQLSTATE or by a message that IS one of
// the stable codes; driver messages, queries and parameters are never read out.
const SAFE_CODES = new Set(['INVALID_TRANSITION', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'CLOCK_REGRESSION', 'POLICY_REQUIRED']);
export function classifySql(error: unknown): { errorClass: ErrorClass; outcome: Outcome } {
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code: unknown }).code) : '';
  const message = error instanceof Error ? error.message : '';
  if (SAFE_CODES.has(message)) return { errorClass: message as ErrorClass, outcome: 'rejected' };
  if (code === '55P03' || code === '57014' || code === '40P01') return { errorClass: 'RETRYABLE_TIMEOUT', outcome: 'failure' };
  if (code === '42501') return { errorClass: 'FORBIDDEN', outcome: 'rejected' };
  if (code === '22023') return { errorClass: 'INVALID_INPUT', outcome: 'rejected' };
  if (code === '40001') return { errorClass: 'VERSION_CONFLICT', outcome: 'rejected' };
  if (/^(08|57P|53)/.test(code) || /ECONNREFUSED|CONNECT_TIMEOUT|CONNECTION/.test(code)) return { errorClass: 'DB_UNAVAILABLE', outcome: 'failure' };
  return { errorClass: 'INTERNAL', outcome: 'failure' };
}

// OBS-03 readiness: each dependency probe is bounded; slow → DEGRADED,
// failure/timeout → DOWN. Results are cached so a public probe cannot turn
// into load on Auth or PostgreSQL. Nothing but statuses leaves the process.
export type Probe = () => Promise<void>;
export interface Readiness { status: Status; checks: Record<string, Status> }

export async function readiness(probes: Record<string, Probe>, degradedMs = 1000, timeoutMs = 2000): Promise<Readiness> {
  const entries = await Promise.all(Object.entries(probes).map(async ([name, probe]) => {
    const started = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([probe(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), timeoutMs); })]);
      return [name, performance.now() - started > degradedMs ? 'DEGRADED' : 'UP'] as const;
    } catch {
      return [name, 'DOWN'] as const;
    } finally {
      clearTimeout(timer);
    }
  }));
  const checks = Object.fromEntries(entries) as Record<string, Status>;
  const values = Object.values(checks);
  const status: Status = values.includes('DOWN') ? 'DOWN' : values.includes('DEGRADED') ? 'DEGRADED' : 'UP';
  return { status, checks };
}

const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store, max-age=0', 'X-Content-Type-Options': 'nosniff' };

export function healthHandler(component: Component, probes: Record<string, Probe>, cacheMs = 5000): (path: string) => Promise<Response | null> {
  let cached: { at: number; value: Readiness } | null = null;
  let pending: Promise<Readiness> | null = null;
  return async (path: string) => {
    const started = performance.now();
    if (/\/health\/live\/?$/.test(path)) {
      opsEvent(component, 'health.live', 'success', { duration_ms: performance.now() - started, status: 200 });
      return new Response(JSON.stringify({ status: 'UP' }), { status: 200, headers: HEADERS });
    }
    if (!/\/health\/ready\/?$/.test(path)) return null;
    if (!cached || performance.now() - cached.at > cacheMs) {
      pending ??= readiness(probes).finally(() => { pending = null; });
      const value = await pending;
      cached = { at: performance.now(), value };
    }
    const { status, checks } = cached.value;
    const code = status === 'DOWN' ? 503 : 200;
    opsEvent(component, 'health.ready', status === 'UP' ? 'success' : status === 'DEGRADED' ? 'degraded' : 'failure',
      { duration_ms: performance.now() - started, status: code, error_class: status === 'UP' ? 'NONE' : status === 'DEGRADED' ? 'DEGRADED' : 'INTERNAL' });
    return new Response(JSON.stringify({ status, checks }), { status: code, headers: HEADERS });
  };
}

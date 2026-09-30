import { canonical, csvDetail, packageSnapshot, rows, safeText, type EvidenceSnapshot } from './package.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function sample(zone: string, start: string, end: string, code = '=SUM(1,1)'): EvidenceSnapshot {
  return {
    schema_version: 1,
    organization_id: '11111111-1111-4111-8111-111111111111',
    employee_id: '22222222-2222-4222-8222-222222222222',
    local_start: '2026-01-01',
    local_end: '2026-12-31',
    timezone: zone,
    cutoff_at: '2026-12-31T23:59:59Z',
    employees: [{
      id: '22222222-2222-4222-8222-222222222222',
      code,
      display_name: 'Alfa, Beta',
      classifications: [],
      sessions: [{
        id: '33333333-3333-4333-8333-333333333333',
        timezone: zone,
        policy: { id: '44444444-4444-4444-8444-444444444444', version: 1, break_counts_as_work: false },
        originals: [{ id: 'event-in' }, { id: 'event-out' }],
        adjustments: [],
        effective: [
          { event_id: 'event-in', adjustment_id: null, event_type: 'CLOCK_IN', effective_at: start, ordinal: 1, source: 'WEB', actor_membership_id: 'actor' },
          { event_id: 'event-out', adjustment_id: null, event_type: 'CLOCK_OUT', effective_at: end, ordinal: 2, source: 'WEB', actor_membership_id: 'actor' },
        ],
      }],
    }],
  };
}

Deno.test('edge export renderer produces CSV JSON PDF and ZIP', async () => {
  const snapshot = sample('Europe/Madrid', '2026-02-01T10:00:00Z', '2026-02-01T11:00:00Z');
  const rendered = rows(snapshot);
  assert(rendered.length === 1 && rendered[0].computable_seconds === 3600, 'computable duration');
  const csv = new TextDecoder().decode(csvDetail(rendered));
  assert(csv.includes("'=SUM(1,1)"), 'formula escaped');
  assert(new TextDecoder().decode(canonical(snapshot)).endsWith('\n'), 'canonical newline');
  const { archive, digest } = await packageSnapshot(snapshot);
  assert(archive[0] === 0x50 && archive[1] === 0x4b, 'zip header');
  assert(/^[0-9a-f]{64}$/.test(digest), 'digest');
});

Deno.test('edge export renderer handles DST and open sessions', () => {
  const spring = rows(sample('Europe/Madrid', '2026-03-28T23:00:00Z', '2026-03-29T22:00:00Z'));
  const autumn = rows(sample('Europe/Madrid', '2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z'));
  assert(spring.reduce((n, row) => n + Number(row.gross_seconds), 0) === 23 * 3600, 'spring 23h');
  assert(autumn.reduce((n, row) => n + Number(row.gross_seconds), 0) === 25 * 3600, 'autumn 25h');
  const open = sample('Europe/Madrid', '2026-02-01T10:00:00Z', '2026-02-01T11:00:00Z');
  open.employees[0].sessions[0].effective.pop();
  assert(rows(open)[0].computable_seconds === null, 'open session is not zero');
});

Deno.test('edge export CSV escapes all formula prefixes', () => {
  for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
    assert(safeText(prefix + 'cmd') === "'" + prefix + 'cmd', 'formula prefix');
  }
});

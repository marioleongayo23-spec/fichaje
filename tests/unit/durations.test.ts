import { describe, expect, it } from 'vitest';
import { computableMonth, sessionTotals, type TimedEvent } from '../../src/domain/durations';

const e = (session_id: string, event_type: TimedEvent['event_type'], effective_at: string, ordinal: number): TimedEvent =>
  ({ session_id, event_type, effective_at, ordinal });

describe('session totals (informative)', () => {
  const day = [e('s', 'CLOCK_IN', '2026-09-22T07:00:00Z', 1), e('s', 'BREAK_START', '2026-09-22T11:00:00Z', 2),
    e('s', 'BREAK_END', '2026-09-22T11:30:00.000001Z', 3), e('s', 'CLOCK_OUT', '2026-09-22T15:00:00Z', 4)];
  it('shows gross, break, net and computable without rounding the original', () => {
    expect(sessionTotals(day, false)).toEqual({ valid: true, closed: true, grossSeconds: 28800, breakSeconds: 1800, netSeconds: 27000, computableSeconds: 27000 });
    expect(sessionTotals(day, true).computableSeconds).toBe(28800);
  });
  it('orders by effective time then ordinal, independent of input order', () => {
    expect(sessionTotals([...day].reverse(), false).grossSeconds).toBe(28800);
  });
  it('never reports an open session as zero hours', () => {
    expect(sessionTotals(day.slice(0, 2), false)).toEqual({ valid: true, closed: false, grossSeconds: null, breakSeconds: null, netSeconds: null, computableSeconds: null });
  });
  it('handles exit from pause (no synthetic break end) and zero-length intervals', () => {
    const paused = [e('s', 'CLOCK_IN', '2026-09-22T07:00:00Z', 1), e('s', 'BREAK_START', '2026-09-22T09:00:00Z', 2), e('s', 'CLOCK_OUT', '2026-09-22T09:00:00Z', 3)];
    expect(sessionTotals(paused, false)).toMatchObject({ grossSeconds: 7200, breakSeconds: 0, computableSeconds: 7200 });
  });
  it('flags a session without a valid entry', () => {
    expect(sessionTotals([e('s', 'CLOCK_OUT', '2026-09-22T07:00:00Z', 1)], false).valid).toBe(false);
  });
});

describe('computable month mirrors private.computable_month', () => {
  const policies = new Map([['a', { timezone: 'Europe/Madrid', breakCountsAsWork: false }], ['b', { timezone: 'Europe/Madrid', breakCountsAsWork: true }],
    ['c', { timezone: 'Europe/Madrid', breakCountsAsWork: false }], ['n', { timezone: 'Europe/Madrid', breakCountsAsWork: false }]]);
  const events = [
    e('a', 'CLOCK_IN', '2026-08-31T22:30:00Z', 1), e('a', 'CLOCK_OUT', '2026-09-01T02:30:00Z', 2), // local 1 Sept 00:30: September
    e('b', 'CLOCK_IN', '2026-09-10T07:00:00.4Z', 3), e('b', 'BREAK_START', '2026-09-10T09:00:00Z', 4), e('b', 'CLOCK_OUT', '2026-09-10T10:00:00Z', 5),
    e('c', 'CLOCK_IN', '2026-08-31T21:30:00Z', 6), e('c', 'CLOCK_OUT', '2026-08-31T23:00:00Z', 7), // local 31 Aug: August
  ];
  it('attributes sessions to the local month of entry and rounds the sum once', () => {
    expect(computableMonth(events, policies, '2026-09')).toEqual({ computableSeconds: 4 * 3600 + 3 * 3600, openSessions: 0 });
    expect(computableMonth(events, policies, '2026-08')).toEqual({ computableSeconds: 5400, openSessions: 0 });
  });
  it('counts open sessions so the server will reject the period', () => {
    const open = [...events, e('n', 'CLOCK_IN', '2026-09-20T07:00:00Z', 8), e('n', 'BREAK_START', '2026-09-20T09:00:00Z', 9)];
    expect(computableMonth(open, policies, '2026-09')).toEqual({ computableSeconds: 7 * 3600 + 2 * 3600, openSessions: 1 });
  });
});

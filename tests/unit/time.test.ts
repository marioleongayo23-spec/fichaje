import { describe, expect, it } from 'vitest';
import { daysBetween, formatDuration, formatTime, localDate, monthRange, parseInstant, previousMonth, spokenDuration, zonedCandidates } from '../../src/lib/time';

describe('server instants', () => {
  it('keeps PostgreSQL microseconds exactly', () => {
    expect(parseInstant('2026-09-22T07:02:15.123456+00:00')).toBe(Date.UTC(2026, 8, 22, 7, 2, 15) * 1000 + 123456);
    expect(parseInstant('2026-09-22 07:02:15+02')).toBe(Date.UTC(2026, 8, 22, 5, 2, 15) * 1000);
    expect(parseInstant('2026-09-22T07:02:15.5Z')).toBe(Date.UTC(2026, 8, 22, 7, 2, 15) * 1000 + 500000);
  });
  it('rejects malformed values', () => {
    expect(() => parseInstant('22/09/2026')).toThrow();
    expect(() => parseInstant('2026-09-22T07:02:15')).toThrow();
  });
  it('formats in the session zone, not the device zone', () => {
    expect(formatTime('2026-07-01T10:00:00Z', 'Europe/Madrid', true)).toBe('12:00:00');
    expect(formatTime('2026-07-01T10:00:00Z', 'Atlantic/Canary')).toBe('11:00');
    expect(localDate('2026-03-28T23:30:00Z', 'Europe/Madrid')).toBe('2026-03-29');
  });
});

describe('local wall time to instant (DST safe)', () => {
  it('maps an ordinary time to exactly one instant', () => {
    expect(zonedCandidates('2026-09-22', '09:00', 'Europe/Madrid').map((d) => d.toISOString())).toEqual(['2026-09-22T07:00:00.000Z']);
    expect(zonedCandidates('2026-01-15', '09:00', 'Atlantic/Canary').map((d) => d.toISOString())).toEqual(['2026-01-15T09:00:00.000Z']);
  });
  it('returns nothing inside the spring-forward gap', () => {
    expect(zonedCandidates('2026-03-29', '02:30', 'Europe/Madrid')).toEqual([]);
    expect(zonedCandidates('2026-03-29', '01:30', 'Atlantic/Canary')).toEqual([]);
  });
  it('returns both instants for the repeated autumn hour', () => {
    expect(zonedCandidates('2026-10-25', '02:30', 'Europe/Madrid').map((d) => d.toISOString()))
      .toEqual(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']);
    expect(zonedCandidates('2026-10-25', '01:30', 'Atlantic/Canary')).toHaveLength(2);
  });
  it('rejects malformed input', () => {
    expect(zonedCandidates('2026-9-1', '09:00', 'Europe/Madrid')).toEqual([]);
  });
});

describe('calendar helpers', () => {
  it('computes month ranges and previous months', () => {
    expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(monthRange('2028-02').end).toBe('2028-02-29');
    expect(previousMonth('2026-01')).toBe('2025-12');
    expect(daysBetween('2026-01-01', '2026-12-31')).toBe(364);
  });
  it('formats durations visually and for screen readers', () => {
    expect(formatDuration(8 * 3600 + 5 * 60 + 59)).toBe('8 h 05 min');
    expect(spokenDuration(3600 + 60)).toBe('1 hora y 1 minuto');
    expect(formatDuration(-5)).toBe('0 h 00 min');
  });
});

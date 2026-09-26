import { describe, expect, it } from 'vitest';
import { addOperation, describeOperation, nextOrdinal, reasonError, replaceOperation, voidOperation } from '../../src/domain/corrections';
import { ACTIONS_BY_STATE } from '../../src/domain/labels';
import type { TimelineItem } from '../../src/domain/types';

const original: TimelineItem = { event_id: 'e1', adjustment_id: null, session_id: 's1', event_type: 'CLOCK_OUT', server_at: '2026-09-22T16:05:00Z',
  effective_at: '2026-09-22T16:05:00Z', ordinal: 4, source: 'WEB', actor_membership_id: 'm1' };
const corrected: TimelineItem = { ...original, adjustment_id: 'a1', source: 'CORRECTION', effective_at: '2026-09-22T15:00:00Z' };
const added: TimelineItem = { ...original, event_id: null, adjustment_id: 'a2', source: 'CORRECTION', event_type: 'BREAK_START' };
const ALLOWED = ['operation', 'target_event_id', 'supersedes_adjustment_id', 'session_id', 'effective_at', 'event_type', 'ordinal', 'timezone'];

describe('clock actions offered per state (presentation only)', () => {
  it('matches the authoritative state machine', () => {
    expect(ACTIONS_BY_STATE).toEqual({ OUT: ['CLOCK_IN'], WORKING: ['BREAK_START', 'CLOCK_OUT'], PAUSED: ['BREAK_END', 'CLOCK_OUT'] });
  });
});

describe('correction proposals follow the H3 contract', () => {
  const at = new Date('2026-09-22T15:00:00Z');
  it('replaces an untouched original by target only', () => {
    expect(replaceOperation(original, at, 'Europe/Madrid')).toEqual({ operation: 'REPLACE', target_event_id: 'e1', session_id: 's1',
      event_type: 'CLOCK_OUT', effective_at: '2026-09-22T15:00:00.000Z', timezone: 'Europe/Madrid', ordinal: 4 });
  });
  it('revises the current leaf of a corrected original or an added event', () => {
    expect(replaceOperation(corrected, at, 'Europe/Madrid')).toMatchObject({ target_event_id: 'e1', supersedes_adjustment_id: 'a1' });
    const revision = replaceOperation(added, at, 'Europe/Madrid');
    expect(revision).toMatchObject({ supersedes_adjustment_id: 'a2' });
    expect('target_event_id' in revision).toBe(false);
  });
  it('voids without time, type or ordinal', () => {
    expect(voidOperation(corrected)).toEqual({ operation: 'VOID', target_event_id: 'e1', supersedes_adjustment_id: 'a1', session_id: 's1' });
  });
  it('adds with an explicit ordinal after all known items', () => {
    expect(addOperation('s9', 'CLOCK_IN', at, 'Atlantic/Canary', nextOrdinal([original, added]))).toEqual({ operation: 'ADD', session_id: 's9',
      event_type: 'CLOCK_IN', effective_at: '2026-09-22T15:00:00.000Z', timezone: 'Atlantic/Canary', ordinal: 5 });
    expect(nextOrdinal([], 2)).toBe(3);
  });
  it('never emits keys the server rejects', () => {
    for (const op of [replaceOperation(original, at, 'Europe/Madrid'), voidOperation(added), addOperation('s', 'CLOCK_OUT', at, 'Europe/Madrid', 1)]) {
      expect(Object.keys(op).every((k) => ALLOWED.includes(k))).toBe(true);
    }
  });
  it('requires a bounded reason', () => {
    expect(reasonError('  ')).toBe('El motivo es obligatorio.');
    expect(reasonError('x'.repeat(1001))).toMatch(/1000/);
    expect(reasonError('Olvidé fichar')).toBeNull();
  });
  it('describes proposals in plain language', () => {
    expect(describeOperation(replaceOperation(original, at, 'Europe/Madrid'), [original], 'Europe/Madrid')).toBe('Cambiar salida del 22/09/2026 18:05 al 22/09/2026 17:00');
    expect(describeOperation(voidOperation(original), [original], 'Europe/Madrid')).toBe('Anular salida del 22/09/2026 18:05');
    expect(describeOperation(addOperation('s', 'CLOCK_IN', at, 'Europe/Madrid', 1), [], 'Europe/Madrid')).toBe('Añadir entrada el 22/09/2026 17:00');
  });
});

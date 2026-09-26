import { formatDateTime } from '../lib/time';
import { EVENT_LABEL } from './labels';
import type { CorrectionOperation, TimeAction, TimelineItem } from './types';

// Builds H3 proposals. Originals are never edited: every change is an ADD,
// REPLACE or VOID of the current effective item, decided later by a manager.
export const REASON_MAX = 1000;

export function reasonError(reason: string): string | null {
  const length = reason.trim().length;
  if (length === 0) return 'El motivo es obligatorio.';
  if (length > REASON_MAX) return `El motivo no puede superar ${REASON_MAX} caracteres.`;
  return null;
}

// References the current leaf: original (target) and/or last approved adjustment.
function leaf(item: TimelineItem): Pick<CorrectionOperation, 'target_event_id' | 'supersedes_adjustment_id' | 'session_id'> {
  return {
    ...(item.event_id ? { target_event_id: item.event_id } : {}),
    ...(item.adjustment_id ? { supersedes_adjustment_id: item.adjustment_id } : {}),
    session_id: item.session_id,
  };
}

export function replaceOperation(item: TimelineItem, effectiveAt: Date, timezone: string): CorrectionOperation {
  return { operation: 'REPLACE', ...leaf(item), event_type: item.event_type, effective_at: effectiveAt.toISOString(), timezone, ordinal: item.ordinal };
}
export function voidOperation(item: TimelineItem): CorrectionOperation {
  return { operation: 'VOID', ...leaf(item) };
}
export function addOperation(sessionId: string, eventType: TimeAction, effectiveAt: Date, timezone: string, ordinal: number): CorrectionOperation {
  return { operation: 'ADD', session_id: sessionId, event_type: eventType, effective_at: effectiveAt.toISOString(), timezone, ordinal };
}

// Ordinals only break ties between equal instants; new items go after all others.
export function nextOrdinal(items: Pick<TimelineItem, 'ordinal'>[], offset = 0): number {
  return items.reduce((max, item) => Math.max(max, item.ordinal), 0) + 1 + offset;
}

export function describeOperation(op: CorrectionOperation, items: TimelineItem[], zone: string): string {
  const current = items.find((i) =>
    (op.supersedes_adjustment_id && i.adjustment_id === op.supersedes_adjustment_id) ||
    (!op.supersedes_adjustment_id && op.target_event_id && i.event_id === op.target_event_id && !i.adjustment_id));
  const what = op.event_type ? EVENT_LABEL[op.event_type].toLowerCase() : current ? EVENT_LABEL[current.event_type].toLowerCase() : 'fichaje';
  const when = op.effective_at ? formatDateTime(op.effective_at, op.timezone ?? zone) : '';
  if (op.operation === 'ADD') return `Añadir ${what} el ${when}`;
  if (op.operation === 'VOID') {
    return current ? `Anular ${what} del ${formatDateTime(current.effective_at, zone)}` : `Anular ${what}`;
  }
  return current
    ? `Cambiar ${what} del ${formatDateTime(current.effective_at, zone)} al ${when}`
    : `Cambiar ${what} al ${when}`;
}

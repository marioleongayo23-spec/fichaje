import { parseInstant } from '../lib/time';
import { sortEvents } from './durations';
import type { CorrectionDecision, CorrectionRequest, HourClassification, TimeAction, TimelineItem, WorkPolicy } from './types';

// Shape of the H5 evidence snapshot (get_own_evidence). Read-only, in memory.
export interface OriginalEvent {
  id: string; session_id: string; sequence: number; event_type: TimeAction; server_at: string;
  source: 'WEB' | 'KIOSK'; actor_membership_id: string | null; kiosk_device_id: string | null;
}
export interface Adjustment {
  id: string; operation: 'ADD' | 'REPLACE' | 'VOID'; target_event_id: string | null; supersedes_adjustment_id: string | null;
  effective_at: string | null; event_type: TimeAction | null; session_id: string; ordinal: number | null; created_at: string;
}
export interface EvidenceSession {
  id: string; timezone: string; policy: WorkPolicy; originals: OriginalEvent[];
  adjustments: { adjustment: Adjustment; decision: CorrectionDecision; request: CorrectionRequest }[];
  effective: TimelineItem[];
}
export interface EvidenceEmployee {
  id: string; code: string; display_name: string; sessions: EvidenceSession[];
  correction_requests: { request: CorrectionRequest; decision: CorrectionDecision | null }[];
  classifications: HourClassification[];
}
export interface EvidenceSnapshot {
  schema_version: number; cutoff_at: string; timezone: string; local_start: string; local_end: string; employees: EvidenceEmployee[];
}

export function sessionEntry(session: Pick<EvidenceSession, 'effective' | 'originals'>): string | null {
  const effective = sortEvents(session.effective);
  if (effective.length) return effective[0].effective_at;
  const originals = [...session.originals].sort((a, b) => a.sequence - b.sequence);
  return originals[0]?.server_at ?? null;
}

export function sortSessions<T extends Pick<EvidenceSession, 'effective' | 'originals'>>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => {
    const x = sessionEntry(a), y = sessionEntry(b);
    return (x ? parseInstant(x) : 0) - (y ? parseInstant(y) : 0);
  });
}

// How each immutable original ended up in the effective timeline.
export function originalFate(original: OriginalEvent, session: EvidenceSession): 'VIGENTE' | 'SUSTITUIDO' | 'ANULADO' {
  const chain = session.adjustments.map((a) => a.adjustment).filter((a) => a.target_event_id === original.id);
  if (!chain.length) return 'VIGENTE';
  const leaf = chain.find((a) => !chain.some((b) => b.supersedes_adjustment_id === a.id));
  return leaf?.operation === 'VOID' ? 'ANULADO' : 'SUSTITUIDO';
}

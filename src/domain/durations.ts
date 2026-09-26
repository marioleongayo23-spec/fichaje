import { localDate, parseInstant } from '../lib/time';
import type { TimeAction } from './types';

// Informative totals derived from the server's effective timeline. Nothing here
// is authoritative: exports and classifications are validated server-side.
export interface TimedEvent { session_id: string; event_type: TimeAction; effective_at: string; ordinal: number }

export function sortEvents<T extends TimedEvent>(events: T[]): T[] {
  return [...events].sort((a, b) => parseInstant(a.effective_at) - parseInstant(b.effective_at) || a.ordinal - b.ordinal);
}

// PostgreSQL round(numeric): half away from zero; values here are never negative.
function roundSeconds(micros: number): number {
  return Math.floor((micros + 500_000) / 1_000_000);
}

export interface SessionTotals {
  valid: boolean; closed: boolean;
  grossSeconds: number | null; breakSeconds: number | null; netSeconds: number | null; computableSeconds: number | null;
}

// An open (incomplete) session is an incident: no totals, never zero hours.
export function sessionTotals(events: TimedEvent[], breakCountsAsWork: boolean): SessionTotals {
  const sorted = sortEvents(events);
  const valid = sorted.length > 0 && sorted[0].event_type === 'CLOCK_IN';
  const closed = valid && sorted[sorted.length - 1].event_type === 'CLOCK_OUT';
  if (!closed) return { valid, closed, grossSeconds: null, breakSeconds: null, netSeconds: null, computableSeconds: null };
  let gross = 0, pause = 0, computable = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const length = parseInstant(sorted[i + 1].effective_at) - parseInstant(sorted[i].effective_at);
    gross += length;
    if (sorted[i].event_type === 'BREAK_START') {
      pause += length;
      if (breakCountsAsWork) computable += length;
    } else if (sorted[i].event_type === 'CLOCK_IN' || sorted[i].event_type === 'BREAK_END') {
      computable += length;
    }
  }
  const grossSeconds = roundSeconds(gross), breakSeconds = roundSeconds(pause);
  return { valid, closed, grossSeconds, breakSeconds, netSeconds: grossSeconds - breakSeconds, computableSeconds: roundSeconds(computable) };
}

export interface SessionPolicy { timezone: string; breakCountsAsWork: boolean }

// Mirrors private.computable_month so a manager can prefill a classification.
// The server recomputes and rejects any mismatch (HOURS_MISMATCH).
export function computableMonth(events: TimedEvent[], sessions: Map<string, SessionPolicy>, month: string): { computableSeconds: number; openSessions: number } {
  const bySession = new Map<string, TimedEvent[]>();
  for (const event of events) bySession.set(event.session_id, [...(bySession.get(event.session_id) ?? []), event]);
  let total = 0;
  const open = new Set<string>();
  for (const [sessionId, list] of bySession) {
    const policy = sessions.get(sessionId);
    if (!policy) continue;
    const sorted = sortEvents(list);
    if (sorted[0].event_type !== 'CLOCK_IN') continue;
    if (localDate(sorted[0].effective_at, policy.timezone).slice(0, 7) !== month) continue;
    sorted.forEach((event, index) => {
      const next = sorted[index + 1];
      if (!next) {
        if (event.event_type !== 'CLOCK_OUT') open.add(sessionId);
        return;
      }
      if (event.event_type === 'CLOCK_IN' || event.event_type === 'BREAK_END' ||
          (event.event_type === 'BREAK_START' && policy.breakCountsAsWork)) {
        total += parseInstant(next.effective_at) - parseInstant(event.effective_at);
      }
    });
  }
  return { computableSeconds: roundSeconds(total), openSessions: open.size };
}

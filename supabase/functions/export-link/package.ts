import { zipSync } from 'fflate';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Temporal } from '@js-temporal/polyfill';

const HEADINGS = [
  'organization_id', 'employee_id', 'employee_code', 'employee_name',
  'session_id', 'local_entry_day', 'natural_day', 'timezone', 'status',
  'original_event_ids', 'adjustment_ids', 'effective_event_ids', 'sources',
  'actors', 'policy_id', 'policy_version', 'gross_seconds', 'break_seconds',
  'net_seconds', 'computable_seconds', 'classification_ids',
] as const;

type Action = 'CLOCK_IN' | 'BREAK_START' | 'BREAK_END' | 'CLOCK_OUT';
interface EffectiveEvent {
  event_id?: string | null;
  adjustment_id?: string | null;
  event_type: Action;
  effective_at: string;
  ordinal: number;
  source: string;
  actor_membership_id?: string | null;
}
interface SessionSnapshot {
  id: string;
  timezone: string;
  policy: { id: string; version: number; break_counts_as_work: boolean };
  originals: Array<{ id: string }>;
  adjustments: Array<{ adjustment: { id: string } }>;
  effective: EffectiveEvent[];
}
interface EmployeeSnapshot {
  id: string;
  code: string;
  display_name: string;
  sessions: SessionSnapshot[];
  classifications: Array<{ id: string; local_month: string }>;
}
export interface EvidenceSnapshot {
  schema_version: number;
  organization_id: string;
  employee_id: string | null;
  local_start: string;
  local_end: string;
  timezone: string;
  cutoff_at: string;
  employees: EmployeeSnapshot[];
}
type Row = Record<(typeof HEADINGS)[number], string | number | null>;

const encoder = new TextEncoder();

async function sha256(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
  return Array.from(hash, (x) => x.toString(16).padStart(2, '0')).join('');
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sortJson(v)]));
  }
  return value;
}

export function canonical(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(sortJson(value)) + '\n');
}

export function safeText(value: unknown): string {
  const text = value == null ? '' : String(value);
  return /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
}

function instant(value: string): Temporal.Instant {
  return Temporal.Instant.from(value);
}

function nextLocalMidnight(current: Temporal.Instant, zone: string): Temporal.Instant {
  const next = current.toZonedDateTimeISO(zone).toPlainDate().add({ days: 1 }).toString();
  return Temporal.ZonedDateTime.from(`${next}T00:00[${zone}]`).toInstant();
}

function seconds(start: Temporal.Instant, end: Temporal.Instant): number {
  return Math.round((end.epochMilliseconds - start.epochMilliseconds) / 1000);
}

export function rows(snapshot: EvidenceSnapshot): Row[] {
  const output: Row[] = [];
  for (const employee of snapshot.employees) {
    for (const session of employee.sessions) {
      const events = [...session.effective].sort((a, b) => {
        const delta = instant(a.effective_at).epochMilliseconds - instant(b.effective_at).epochMilliseconds;
        return delta || a.ordinal - b.ordinal;
      });
      if (!events.length) continue;
      if (events[0].event_type !== 'CLOCK_IN') throw new Error('INVALID_TIMELINE');
      const entry = instant(events[0].effective_at).toZonedDateTimeISO(session.timezone).toPlainDate().toString();
      const closed = events.at(-1)?.event_type === 'CLOCK_OUT';
      const grouped = new Map<string, { gross: number; pause: number; computable: number }>();

      for (let i = 0; i + 1 < events.length; i++) {
        const current = events[i];
        let cursor = instant(current.effective_at);
        const end = instant(events[i + 1].effective_at);
        if (end.epochMilliseconds < cursor.epochMilliseconds) throw new Error('INVALID_TIMELINE');
        while (cursor.epochMilliseconds < end.epochMilliseconds) {
          const day = cursor.toZonedDateTimeISO(session.timezone).toPlainDate().toString();
          const boundary = nextLocalMidnight(cursor, session.timezone);
          const stop = boundary.epochMilliseconds < end.epochMilliseconds ? boundary : end;
          if (stop.epochMilliseconds <= cursor.epochMilliseconds) throw new Error('INVALID_TIMEZONE');
          const values = grouped.get(day) ?? { gross: 0, pause: 0, computable: 0 };
          const length = seconds(cursor, stop);
          values.gross += length;
          if (current.event_type === 'BREAK_START') {
            values.pause += length;
            if (session.policy.break_counts_as_work) values.computable += length;
          } else if (current.event_type === 'CLOCK_IN' || current.event_type === 'BREAK_END') {
            values.computable += length;
          }
          grouped.set(day, values);
          cursor = stop;
        }
      }
      if (!grouped.size) grouped.set(entry, { gross: 0, pause: 0, computable: 0 });

      for (const [day, values] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        output.push({
          organization_id: snapshot.organization_id,
          employee_id: employee.id,
          employee_code: employee.code,
          employee_name: employee.display_name,
          session_id: session.id,
          local_entry_day: entry,
          natural_day: day,
          timezone: session.timezone,
          status: closed ? 'CLOSED' : 'OPEN_SESSION',
          original_event_ids: session.originals.map((e) => e.id).join(';'),
          adjustment_ids: session.adjustments.map((a) => a.adjustment.id).join(';'),
          effective_event_ids: events.map((e) => e.event_id ?? e.adjustment_id ?? '').join(';'),
          sources: events.map((e) => e.source).join(';'),
          actors: events.map((e) => e.actor_membership_id ?? '').join(';'),
          policy_id: session.policy.id,
          policy_version: session.policy.version,
          gross_seconds: closed ? values.gross : null,
          break_seconds: closed ? values.pause : null,
          net_seconds: closed ? values.gross - values.pause : null,
          computable_seconds: closed ? values.computable : null,
          classification_ids: employee.classifications
            .filter((c) => c.local_month.slice(0, 7) === entry.slice(0, 7))
            .map((c) => c.id).join(';'),
        });
      }
    }
  }
  return output;
}

function csvCell(value: string | number | null): string {
  const text = typeof value === 'number' ? String(value) : safeText(value);
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

export function csvDetail(entries: Row[]): Uint8Array {
  const lines = [HEADINGS.join(','), ...entries.map((row) => HEADINGS.map((key) => csvCell(row[key])).join(','))];
  return encoder.encode(lines.join('\r\n') + '\r\n');
}

function pdfSafe(value: string): string {
  return value.replace(/[^\x20-\xFF]/g, '?');
}

async function pdfSummary(snapshot: EvidenceSnapshot, entries: Row[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Resumen mensual de registro horario');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageSize: [number, number] = [595.28, 841.89];
  let page = doc.addPage(pageSize);
  let y = 805;
  const size = 9;
  const maxWidth = 525;

  const source = [
    'Registro horario - resumen mensual',
    'Organizacion: ' + snapshot.organization_id,
    'Periodo local: ' + snapshot.local_start + ' a ' + snapshot.local_end,
    'Zona de filtro: ' + snapshot.timezone,
    'Corte UTC: ' + snapshot.cutoff_at,
    ...entries.map((entry) => {
      const duration = entry.status !== 'CLOSED'
        ? 'INCIDENCIA: SESION ABIERTA'
        : `bruto ${entry.gross_seconds} s; pausa ${entry.break_seconds} s; neto ${entry.net_seconds} s; computable ${entry.computable_seconds} s`;
      return `${entry.employee_code} ${entry.natural_day} ${entry.session_id}: ${duration}`;
    }),
    ...(entries.length ? [] : ['Sin jornadas en el periodo.']),
    'SHA-256 del paquete: ver manifest.json. No es firma electronica cualificada.',
  ];

  for (const raw of source) {
    const words = pdfSafe(raw).split(/\s+/);
    let line = '';
    const flush = () => {
      if (y < 45) { page = doc.addPage(pageSize); y = 805; }
      page.drawText(line || ' ', { x: 35, y, size, font });
      y -= 13;
      line = '';
    };
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (line && font.widthOfTextAtSize(candidate, size) > maxWidth) flush();
      line = line ? line + ' ' + word : word;
    }
    flush();
  }
  return await doc.save({ useObjectStreams: false });
}

export async function packageSnapshot(snapshot: EvidenceSnapshot): Promise<{ archive: Uint8Array; digest: string }> {
  const entries = rows(snapshot);
  const files: Record<string, Uint8Array> = {
    'detail.csv': csvDetail(entries),
    'evidence.json': canonical(snapshot),
    'summary.pdf': await pdfSummary(snapshot, entries),
  };
  const hashes: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) hashes[name] = await sha256(files[name]);
  files['manifest.json'] = canonical({ schema_version: snapshot.schema_version, cutoff_at: snapshot.cutoff_at, files_sha256: hashes });
  const archive = zipSync(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))), { level: 6 });
  return { archive, digest: await sha256(archive) };
}

// Presentation helpers only. Effective times always come from the server; the
// device clock is shown as informative and never sent as an event time.
export const ZONES = [
  { id: 'Europe/Madrid', label: 'Península y Baleares' },
  { id: 'Atlantic/Canary', label: 'Canarias' },
] as const;
export type SpanishZone = (typeof ZONES)[number]['id'];
export const DEFAULT_ZONE: SpanishZone = 'Europe/Madrid';

export function isSpanishZone(zone: string | null | undefined): zone is SpanishZone {
  return ZONES.some((z) => z.id === zone);
}

const INSTANT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/;

// Epoch microseconds, exact for PostgreSQL timestamptz (Date keeps only ms).
export function parseInstant(value: string): number {
  const match = INSTANT.exec(value);
  if (!match) throw new Error('INVALID_INSTANT');
  let offset = match[4];
  if (offset !== 'Z') offset = offset.length === 3 ? `${offset}:00` : offset.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const ms = Date.parse(`${match[1]}T${match[2]}${offset}`);
  if (Number.isNaN(ms)) throw new Error('INVALID_INSTANT');
  return ms * 1000 + Number((match[3] ?? '').padEnd(6, '0'));
}

export function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(Math.floor(parseInstant(value) / 1000));
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = locale + JSON.stringify(options);
  let cached = formatters.get(key);
  if (!cached) formatters.set(key, cached = new Intl.DateTimeFormat(locale, options));
  return cached;
}

export function formatTime(value: string | Date, zone: string, seconds = false): string {
  return formatter('es-ES', { timeZone: zone, hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23' })
    .format(toDate(value));
}
export function formatDate(value: string | Date, zone: string): string {
  return formatter('es-ES', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(toDate(value));
}
export function formatShortDate(value: string | Date, zone: string): string {
  return formatter('es-ES', { timeZone: zone, day: '2-digit', month: '2-digit', year: 'numeric' }).format(toDate(value));
}
export function formatDateTime(value: string | Date, zone: string): string {
  return `${formatShortDate(value, zone)} ${formatTime(value, zone)}`;
}
export function zoneAbbreviation(value: string | Date, zone: string): string {
  const part = formatter('es-ES', { timeZone: zone, timeZoneName: 'short' }).formatToParts(toDate(value))
    .find((p) => p.type === 'timeZoneName');
  return part?.value ?? zone;
}
export function zoneLabel(zone: string): string {
  return ZONES.find((z) => z.id === zone)?.label ?? zone;
}

interface Wall { year: number; month: number; day: number; hour: number; minute: number; second: number }
function wall(epochMs: number, zone: string): Wall {
  const parts = formatter('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}
function wallUtc(w: Wall): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

// Local calendar date (YYYY-MM-DD) of an instant in a zone.
export function localDate(value: string | Date, zone: string): string {
  const w = wall(toDate(value).getTime(), zone);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

// All instants whose local wall time equals date+time in the zone: none in a
// spring-forward gap, two in the repeated autumn hour. Never guess silently.
export function zonedCandidates(date: string, time: string, zone: string): Date[] {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return [];
  const target = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  const offsets = new Set([-12, 0, 12].map((h) => {
    const probe = target + h * 3600_000;
    return wallUtc(wall(probe, zone)) - probe;
  }));
  const found = new Set<number>();
  for (const offset of offsets) {
    const instant = target - offset;
    if (wallUtc(wall(instant, zone)) === target) found.add(instant);
  }
  return [...found].sort((a, b) => a - b).map((ms) => new Date(ms));
}

export function currentMonth(zone: string, now = new Date()): string {
  return localDate(now, zone).slice(0, 7);
}
export function monthRange(month: string): { start: string; end: string } {
  const [year, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}` };
}
export function previousMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, m - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
export function formatMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return formatter('es-ES', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(new Date(Date.UTC(year, m - 1, 15)));
}
export function daysBetween(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000);
}

export function durationParts(totalSeconds: number): { hours: number; minutes: number } {
  const minutes = Math.floor(Math.max(0, totalSeconds) / 60);
  return { hours: Math.floor(minutes / 60), minutes: minutes % 60 };
}
export function formatDuration(totalSeconds: number): string {
  const { hours, minutes } = durationParts(totalSeconds);
  return `${hours} h ${String(minutes).padStart(2, '0')} min`;
}
export function spokenDuration(totalSeconds: number): string {
  const { hours, minutes } = durationParts(totalSeconds);
  return `${hours} ${hours === 1 ? 'hora' : 'horas'} y ${minutes} ${minutes === 1 ? 'minuto' : 'minutos'}`;
}

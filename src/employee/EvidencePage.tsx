import { useState } from 'react';
import { useLoader, usePolicies } from '../app/hooks';
import { Link } from '../app/router';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { sessionTotals, sortEvents } from '../domain/durations';
import { sessionEntry, sortSessions, type EvidenceSession, type EvidenceSnapshot } from '../domain/evidence';
import { rpc } from '../lib/api';
import { currentMonth, DEFAULT_ZONE, formatDateTime, formatMonth, formatTime, isSpanishZone, localDate, monthRange, ZONES, type SpanishZone } from '../lib/time';
import { BundyEmployeeNav, BundyPhoneScreen, BundyStatusBar } from '../ui/BundyMobile';
import { EmptyState, Field, LiveRegion, Loading, Notice, PageHeader } from '../ui/components';
import { CorrectionDialog } from './CorrectionDialog';
import { SessionView } from './SessionView';

type Period = 'week' | 'month';

function mondayOf(local: string): string {
  const day = new Date(`${local}T00:00:00Z`);
  const offset = (day.getUTCDay() + 6) % 7;
  day.setUTCDate(day.getUTCDate() - offset);
  return day.toISOString().slice(0, 10);
}

function addDays(local: string, days: number): string {
  const date = new Date(`${local}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

function weekdayLabel(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: zone }).format(new Date(iso)).replace('.', '');
}

// Own evidence through the H5 contract (get_own_evidence), at most one month.
export function EvidencePage() {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const employee = tenant.current.employee;
  const org = tenant.current.organization.id;
  const policies = usePolicies(employee?.id ?? null);
  const policyZone = policies.data?.current?.timezone;
  const [zoneChoice, setZoneChoice] = useState<SpanishZone | null>(null);
  const zone: SpanishZone = zoneChoice ?? (isSpanishZone(policyZone) ? policyZone : DEFAULT_ZONE);
  const [month, setMonth] = useState(() => currentMonth(zone));
  const [period, setPeriod] = useState<Period>('week');
  const [correcting, setCorrecting] = useState<{ session: EvidenceSession | null } | null>(null);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const { start, end } = monthRange(month);
  const evidence = useLoader(async () => {
    if (!employee) return null;
    return rpc<EvidenceSnapshot>(client, 'get_own_evidence', { p_organization_id: org, p_start: start, p_end: end, p_timezone: zone });
  }, [client, org, employee?.id, start, end, zone]);

  if (!employee) {
    return (<><PageHeader title="Mi registro" /><Notice tone="info" title="Tu cuenta no tiene ficha de empleado en esta organización." /></>);
  }

  const own = evidence.data?.employees[0];
  const sessions = own ? sortSessions(own.sessions) : [];
  const knownItems = sessions.flatMap((s) => s.effective);
  const latestEntry = [...sessions].reverse().map((s) => sessionEntry(s)).find(Boolean) ?? new Date().toISOString();
  const anchorLocal = localDate(latestEntry, zone);
  const weekStart = mondayOf(anchorLocal);
  const weekEnd = addDays(weekStart, 6);
  const shown = period === 'month' ? sessions : sessions.filter((session) => {
    const entry = sessionEntry(session);
    if (!entry) return false;
    const local = localDate(entry, zone);
    return local >= weekStart && local <= weekEnd;
  });
  const totals = shown.reduce((sum, session) => {
    const value = sessionTotals(sortEvents(session.effective), session.policy.break_counts_as_work);
    if (!value.closed || value.computableSeconds === null) return sum;
    sum.work += value.computableSeconds;
    sum.pause += value.breakSeconds ?? 0;
    return sum;
  }, { work: 0, pause: 0 });

  return (
    <BundyPhoneScreen className="bundy-hours-screen">
      <div className="bundy-screen-content">
        <BundyStatusBar time={formatTime(new Date(), zone)} />
        <PageHeader title="Mi registro">
          <p className="bundy-screen-title">Tus horas</p>
        </PageHeader>

        <div className="bundy-period-tabs" role="group" aria-label="Periodo del registro">
          <button type="button" className={period === 'week' ? 'active' : ''} aria-pressed={period === 'week'} onClick={() => setPeriod('week')}>Semana</button>
          <button type="button" className={period === 'month' ? 'active' : ''} aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>Mes</button>
          <button type="button" disabled title="La vista anual no forma parte de V1">Año</button>
        </div>

        <section className="bundy-hours-summary" aria-labelledby="hours-summary-title">
          <div className="bundy-hours-summary-top">
            <span id="hours-summary-title">{period === 'week' ? 'Semana' : formatMonth(month)}</span>
            <span>{shown.length} jornada{shown.length === 1 ? '' : 's'}</span>
          </div>
          <p className="bundy-hours-total">{durationLabel(totals.work)}</p>
          <div className="bundy-hours-progress" aria-hidden="true"><span style={{ width: shown.length ? '88%' : '0%' }} /></div>
          <div className="bundy-hours-summary-meta">
            <span>Registrado: <strong>{durationLabel(totals.work)}</strong></span>
            <span>Pausas: <strong>{durationLabel(totals.pause)}</strong></span>
          </div>
        </section>

        <form className="bundy-hours-controls" onSubmit={(e) => e.preventDefault()}>
          <Field label="Mes">
            {(p) => <input {...p} type="month" value={month} max={currentMonth(zone)} onChange={(e) => e.target.value && setMonth(e.target.value)} />}
          </Field>
          <Field label="Zona horaria">
            {(p) => (
              <select {...p} value={zone} onChange={(e) => setZoneChoice(e.target.value as SpanishZone)}>
                {ZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
              </select>
            )}
          </Field>
          <button type="button" className="btn btn-link" onClick={() => void evidence.reload()}>Actualizar</button>
        </form>

        <LiveRegion tone="success" message={submitted} />
        {evidence.loading && <Loading label="Cargando tu registro…" />}
        {evidence.error && <Notice tone="error" title={evidence.error} />}

        {evidence.data && (
          <>
            <section className="bundy-hours-list" aria-label={period === 'week' ? 'Jornadas de la semana' : `Jornadas de ${formatMonth(month)}`}>
              {shown.length === 0 ? <EmptyState>No hay jornadas registradas en este periodo.</EmptyState> : shown.map((session) => {
                const events = sortEvents(session.effective);
                const entry = events[0]?.effective_at ?? session.originals[0]?.server_at ?? null;
                const exit = events[events.length - 1]?.event_type === 'CLOCK_OUT' ? events[events.length - 1].effective_at : null;
                const sum = sessionTotals(events, session.policy.break_counts_as_work);
                return (
                  <article className="bundy-hours-row" key={session.id}>
                    <span className="bundy-hours-day">{entry ? weekdayLabel(entry, session.timezone) : '—'}</span>
                    <span className="bundy-hours-range">
                      {entry ? formatTime(entry, session.timezone) : '—'} <span aria-hidden="true">–</span> {exit ? formatTime(exit, session.timezone) : 'abierta'}
                      {session.adjustments.length > 0 && <small>corregido</small>}
                    </span>
                    <strong className="bundy-hours-duration">{sum.computableSeconds === null ? '—' : durationLabel(sum.computableSeconds)}</strong>
                    <button type="button" className="bundy-hours-correct" aria-label="Solicitar corrección de esta jornada"
                      onClick={() => { setSubmitted(null); setCorrecting({ session }); }}>Editar</button>
                  </article>
                );
              })}
            </section>

            <button type="button" className="btn bundy-hours-primary" onClick={() => { setSubmitted(null); setCorrecting({ session: null }); }}>
              Añadir una jornada que falta
            </button>
            <Link to="/exportar" className="bundy-hours-download">Descargar mi registro</Link>

            <details className="bundy-record-details">
              <summary>Ver detalle legal del registro</summary>
              <p className="hint">Consulta realizada el {formatDateTime(evidence.data.cutoff_at, zone)} (corte del servidor).</p>
              {shown.map((session) => <SessionView key={session.id} session={session} />)}
            </details>
          </>
        )}

        {correcting && (
          <CorrectionDialog open employeeId={employee.id} session={correcting.session} knownItems={knownItems}
            newSessionZone={policyZone ?? zone} onClose={() => setCorrecting(null)}
            onSubmitted={(message) => { setCorrecting(null); setSubmitted(message); }} />
        )}
      </div>
      <BundyEmployeeNav />
    </BundyPhoneScreen>
  );
}

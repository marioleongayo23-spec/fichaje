import { useState } from 'react';
import { useLoader, usePolicies } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { sortSessions, type EvidenceSession, type EvidenceSnapshot } from '../domain/evidence';
import { rpc } from '../lib/api';
import { currentMonth, DEFAULT_ZONE, formatDateTime, formatMonth, isSpanishZone, monthRange, ZONES, type SpanishZone } from '../lib/time';
import { EmptyState, Field, LiveRegion, Loading, Notice, PageHeader } from '../ui/components';
import { CorrectionDialog } from './CorrectionDialog';
import { SessionView } from './SessionView';

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

  return (
    <>
      <PageHeader title="Mi registro">
        <p>Tu registro de jornada tal como consta en el servidor: fichajes originales, correcciones aprobadas y jornadas incompletas.</p>
      </PageHeader>
      <form className="filters" onSubmit={(e) => e.preventDefault()}>
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
        <button type="button" className="btn btn-secondary" onClick={() => void evidence.reload()}>Actualizar</button>
      </form>
      <LiveRegion tone="success" message={submitted} />
      {evidence.loading && <Loading label="Cargando tu registro…" />}
      {evidence.error && <Notice tone="error" title={evidence.error} />}
      {evidence.data && (
        <section aria-labelledby="sessions-title">
          <h2 id="sessions-title">Jornadas de {formatMonth(month)}</h2>
          <p className="hint">Consulta realizada el {formatDateTime(evidence.data.cutoff_at, zone)} (corte del servidor).</p>
          {sessions.length === 0 ? <EmptyState>No hay jornadas registradas en este mes.</EmptyState> : sessions.map((session) => (
            <SessionView key={session.id} session={session} onCorrect={() => { setSubmitted(null); setCorrecting({ session }); }} />
          ))}
          <button type="button" className="btn btn-secondary" onClick={() => { setSubmitted(null); setCorrecting({ session: null }); }}>
            Añadir una jornada que falta
          </button>
        </section>
      )}
      {correcting && (
        <CorrectionDialog open employeeId={employee.id} session={correcting.session} knownItems={knownItems}
          newSessionZone={policyZone ?? zone} onClose={() => setCorrecting(null)}
          onSubmitted={(message) => { setCorrecting(null); setSubmitted(message); }} />
      )}
    </>
  );
}

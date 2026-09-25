import { useRef, useState, type FormEvent } from 'react';
import { useLoader } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { computableMonth, type SessionPolicy } from '../domain/durations';
import type { EmployeeState, HourClassification, TimelineItem, WorkSession } from '../domain/types';
import { newRequestId, rpc, select } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { currentMonth, DEFAULT_ZONE, formatDateTime, formatMonth, previousMonth } from '../lib/time';
import { Duration, EmptyState, Field, LiveRegion, Loading, Notice, PageHeader } from '../ui/components';
import { useDirectory } from './data';

function toSeconds(hours: string, minutes: string): number | null {
  const h = hours.trim() === '' ? 0 : Number(hours), m = minutes.trim() === '' ? 0 : Number(minutes);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) return null;
  return h * 3600 + m * 60;
}

// Classification is a manager declaration, never automatic: exceeding a schedule
// does not create overtime. Totals are recomputed and validated by the server.
export function ClassificationsPage() {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const directory = useDirectory();
  const lastClosed = previousMonth(currentMonth(DEFAULT_ZONE));
  const [employeeId, setEmployeeId] = useState('');
  const [month, setMonth] = useState(lastClosed);
  const [values, setValues] = useState({ compH: '', compM: '', overH: '', overM: '' });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);

  const basis = useLoader(async () => {
    if (!employeeId || !directory.data) return null;
    const [timeline, sessions, state, history] = await Promise.all([
      rpc<TimelineItem[]>(client, 'get_effective_timeline', { p_organization_id: org, p_employee_id: employeeId }),
      select<WorkSession>(client.from('work_sessions').select('id,employee_id,policy_id,timezone,created_at').eq('organization_id', org).eq('employee_id', employeeId)),
      rpc<EmployeeState>(client, 'get_employee_state', { p_organization_id: org, p_employee_id: employeeId }),
      select<HourClassification>(client.from('hour_classifications')
        .select('id,employee_id,local_month,previous_id,regular_seconds,complementary_seconds,overtime_seconds,basis_version,reason,actor_membership_id,created_at')
        .eq('organization_id', org).eq('employee_id', employeeId).eq('local_month', `${month}-01`).order('created_at')),
    ]);
    const policies = new Map<string, SessionPolicy>();
    for (const s of sessions) {
      const p = directory.data.policies.find((x) => x.id === s.policy_id);
      if (p) policies.set(s.id, { timezone: s.timezone, breakCountsAsWork: p.break_counts_as_work });
    }
    const totals = computableMonth(timeline, policies, month);
    const leaf = history.find((c) => !history.some((d) => d.previous_id === c.id)) ?? null;
    return { ...totals, version: state.version, history, leaf };
  }, [client, org, employeeId, month, directory.data]);

  const data = basis.data;
  const complementary = toSeconds(values.compH, values.compM);
  const overtime = toSeconds(values.overH, values.overM);
  const regular = data && complementary !== null && overtime !== null ? data.computableSeconds - complementary - overtime : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    if (!data || !employeeId) return;
    if (complementary === null || overtime === null) { setError('Las horas y minutos deben ser números enteros (minutos de 0 a 59).'); return; }
    if (regular === null || regular < 0) { setError('Las horas complementarias y extraordinarias superan el tiempo computable.'); return; }
    if (!reason.trim() || reason.trim().length > 1000) { setError('El motivo es obligatorio (máximo 1000 caracteres).'); return; }
    const args = { p_organization_id: org, p_employee_id: employeeId, p_local_month: `${month}-01`, p_previous_id: data.leaf?.id ?? null,
      p_basis_version: data.version, p_regular_seconds: regular, p_complementary_seconds: complementary, p_overtime_seconds: overtime, p_reason: reason.trim() };
    const key = JSON.stringify(args);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'classify_hours', { ...args, p_request_id: requestId });
      attempt.current = null;
      setStatus('Clasificación registrada. Las anteriores del mismo mes se conservan como historial.');
      setReason('');
      void basis.reload();
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure));
      void basis.reload();
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader title="Clasificación de horas">
        <p>Declara, para un mes cerrado, qué parte del tiempo computable son horas ordinarias, complementarias o extraordinarias. No es una nómina.</p>
      </PageHeader>
      {directory.loading && <Loading />}
      {directory.error && <Notice tone="error" title={directory.error} />}
      {directory.data && (
        <form className="filters" onSubmit={(e) => e.preventDefault()}>
          <Field label="Empleado">
            {(p) => (
              <select {...p} value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setStatus(null); setError(null); }}>
                <option value="">Elige una persona</option>
                {directory.data!.employees.map((e) => <option key={e.id} value={e.id}>{e.display_name} ({e.code})</option>)}
              </select>
            )}
          </Field>
          <Field label="Mes (cerrado)">
            {(p) => <input {...p} type="month" value={month} max={lastClosed} onChange={(e) => e.target.value && setMonth(e.target.value)} />}
          </Field>
        </form>
      )}
      <LiveRegion tone="success" message={status} />
      {employeeId && basis.loading && <Loading />}
      {basis.error && <Notice tone="error" title={basis.error} />}
      {data && (
        <section aria-labelledby="basis-title" className="subsection">
          <h2 id="basis-title">{formatMonth(month)}</h2>
          {data.openSessions > 0 ? (
            <Notice tone="warning" title={`Hay ${data.openSessions} jornada(s) abierta(s) en el mes.`}>
              <p>Deben completarse o corregirse antes de clasificar; el servidor rechaza periodos incompletos.</p>
            </Notice>
          ) : (
            <>
              <p>Tiempo computable del mes: <strong><Duration seconds={data.computableSeconds} /></strong>{data.computableSeconds % 60 ? ` y ${data.computableSeconds % 60} s` : ''}.</p>
              <form noValidate onSubmit={submit}>
                <fieldset className="fieldset">
                  <legend>Horas complementarias</legend>
                  <div className="inline-fields">
                    <Field label="Horas">{(p) => <input {...p} inputMode="numeric" value={values.compH} onChange={(e) => setValues({ ...values, compH: e.target.value })} />}</Field>
                    <Field label="Minutos">{(p) => <input {...p} inputMode="numeric" value={values.compM} onChange={(e) => setValues({ ...values, compM: e.target.value })} />}</Field>
                  </div>
                </fieldset>
                <fieldset className="fieldset">
                  <legend>Horas extraordinarias</legend>
                  <div className="inline-fields">
                    <Field label="Horas">{(p) => <input {...p} inputMode="numeric" value={values.overH} onChange={(e) => setValues({ ...values, overH: e.target.value })} />}</Field>
                    <Field label="Minutos">{(p) => <input {...p} inputMode="numeric" value={values.overM} onChange={(e) => setValues({ ...values, overM: e.target.value })} />}</Field>
                  </div>
                </fieldset>
                <p>Horas ordinarias (resto): <strong>{regular !== null && regular >= 0 ? <Duration seconds={regular} /> : 'no válido'}</strong></p>
                <Field label="Motivo (obligatorio)">{(p) => <textarea {...p} rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
                <LiveRegion tone="error" message={error} />
                <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Registrando…' : data.leaf ? 'Registrar nueva versión' : 'Registrar clasificación'}</button>
              </form>
            </>
          )}
          <h3>Historial del mes</h3>
          {data.history.length === 0 ? <EmptyState>Sin clasificaciones registradas.</EmptyState> : (
            <ul>
              {data.history.map((c) => (
                <li key={c.id}>
                  {formatDateTime(c.created_at, DEFAULT_ZONE)}: ordinarias <Duration seconds={c.regular_seconds} />, complementarias <Duration seconds={c.complementary_seconds} />, extraordinarias <Duration seconds={c.overtime_seconds} />. Motivo: {c.reason}{c.id === data.leaf?.id ? ' (vigente)' : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

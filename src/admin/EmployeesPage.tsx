import { useEffect, useRef, useState, type FormEvent } from 'react';
import { currentPolicy, useLoader } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { sortSessions } from '../domain/evidence';
import { ROLE_LABEL, STATE_LABEL } from '../domain/labels';
import type { Employee, EmployeeState } from '../domain/types';
import { newRequestId, rpc } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { currentMonth, DEFAULT_ZONE, formatDateTime, localDate, zoneLabel, zonedCandidates } from '../lib/time';
import { SessionView } from '../employee/SessionView';
import { Badge, Dialog, EmptyState, Field, LiveRegion, Loading, Notice, PageHeader, TableWrap } from '../ui/components';
import { loadEmployeeSessions, useDirectory, type Directory } from './data';
import { PinReset } from './PinReset';

export function EmployeesPage() {
  const directory = useDirectory();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const data = directory.data;
  const employee = data?.employees.find((e) => e.id === selected) ?? null;

  if (employee && data) {
    return <EmployeeDetail employee={employee} directory={data} onBack={() => setSelected(null)} onChanged={() => void directory.reload()} />;
  }
  return (
    <>
      <PageHeader title="Empleados">
        <p>Fichas de empleado de la organización. Una persona sin correo ni cuenta puede tener ficha y fichar en el kiosco.</p>
      </PageHeader>
      <button type="button" className="btn btn-primary" onClick={() => { setStatus(null); setCreating(true); }}>Nuevo empleado</button>
      <LiveRegion tone="success" message={status} />
      {directory.loading && <Loading />}
      {directory.error && <Notice tone="error" title={directory.error} />}
      {data && (data.employees.length === 0 ? <EmptyState>Todavía no hay empleados.</EmptyState> : (
        <TableWrap label="Empleados de la organización">
          <table className="table">
            <caption className="visually-hidden">Empleados de la organización</caption>
            <thead><tr><th scope="col">Nombre</th><th scope="col">Código</th><th scope="col">Acceso</th><th scope="col">Horario vigente</th><th scope="col">Situación</th><th scope="col"><span className="visually-hidden">Acciones</span></th></tr></thead>
            <tbody>
              {data.employees.map((e) => {
                const membership = data.memberships.find((m) => m.id === e.membership_id);
                const policy = currentPolicy(data.policies, data.assignments.filter((a) => a.employee_id === e.id));
                return (
                  <tr key={e.id}>
                    <th scope="row">{e.display_name}</th>
                    <td>{e.code}</td>
                    <td>{membership ? `Cuenta (${ROLE_LABEL[membership.role]}${membership.active ? '' : ', retirada'})` : 'Sin cuenta: kiosco'}</td>
                    <td>{policy ? `v${policy.version} · ${zoneLabel(policy.timezone)}` : <Badge tone="warning">Sin horario</Badge>}</td>
                    <td>{e.active ? <Badge tone="success">Activo</Badge> : <Badge>Inactivo</Badge>}</td>
                    <td><button type="button" className="btn btn-secondary btn-small" onClick={() => setSelected(e.id)}>Ver ficha<span className="visually-hidden"> de {e.display_name}</span></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      ))}
      {creating && data && (
        <EmployeeForm directory={data} employee={null} onClose={() => setCreating(false)}
          onSaved={(name) => { setCreating(false); setStatus(`Empleado «${name}» creado.`); void directory.reload(); }} />
      )}
    </>
  );
}

function EmployeeForm({ directory, employee, onClose, onSaved }: {
  directory: Directory; employee: Employee | null; onClose: () => void; onSaved: (name: string) => void;
}) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ code?: string; name?: string }>({});
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const newId = useRef(crypto.randomUUID());
  const linkable = directory.memberships.filter((m) => m.active &&
    (m.id === employee?.membership_id || !directory.employees.some((e) => e.membership_id === m.id)));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get('code') ?? '').trim();
    const name = String(form.get('name') ?? '').trim();
    const membership = String(form.get('membership') ?? '') || null;
    const active = form.get('active') === 'on';
    const errors = {
      code: code.length >= 1 && code.length <= 50 ? undefined : 'El código es obligatorio (máximo 50 caracteres).',
      name: name.length >= 1 && name.length <= 200 ? undefined : 'El nombre es obligatorio (máximo 200 caracteres).',
    };
    setFieldErrors(errors);
    if (errors.code || errors.name) { setError('Revisa los campos marcados.'); return; }
    const args = { p_organization_id: tenant.current.organization.id, p_employee_id: employee?.id ?? newId.current,
      p_expected_version: employee?.version ?? 0, p_code: code, p_display_name: name, p_membership_id: membership, p_active: active };
    const key = JSON.stringify(args);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'manage_employee', { ...args, p_request_id: requestId });
      attempt.current = null;
      onSaved(name);
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure).replace('Revisa los datos introducidos.', 'Revisa los datos: el código no puede repetirse en la organización.'));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open title={employee ? `Editar ${employee.display_name}` : 'Nuevo empleado'} onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <Field label="Código de empleado" hint="Único en la organización. Es el que se teclea en el kiosco." error={fieldErrors.code}>
          {(p) => <input {...p} name="code" defaultValue={employee?.code} maxLength={50} autoComplete="off" />}
        </Field>
        <Field label="Nombre visible" error={fieldErrors.name}>
          {(p) => <input {...p} name="name" defaultValue={employee?.display_name} maxLength={200} autoComplete="off" />}
        </Field>
        <Field label="Cuenta vinculada" hint="Sin cuenta, la persona ficha en el kiosco con código y PIN.">
          {(p) => (
            <select {...p} name="membership" defaultValue={employee?.membership_id ?? ''}>
              <option value="">Sin cuenta (kiosco)</option>
              {linkable.map((m) => (
                <option key={m.id} value={m.id}>{`Cuenta ${ROLE_LABEL[m.role].toLowerCase()} dada de alta el ${formatDateTime(m.created_at, DEFAULT_ZONE)}`}</option>
              ))}
            </select>
          )}
        </Field>
        <label className="checkbox"><input type="checkbox" name="active" defaultChecked={employee?.active ?? true} /> Activo (puede fichar)</label>
        <p className="hint">Desactivar impide fichar pero conserva todo su historial.</p>
        <LiveRegion tone="error" message={error} />
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Dialog>
  );
}

function EmployeeDetail({ employee, directory, onBack, onChanged }: { employee: Employee; directory: Directory; onBack: () => void; onChanged: () => void }) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const assignments = directory.assignments.filter((a) => a.employee_id === employee.id);
  const policy = currentPolicy(directory.policies, assignments);
  const zone = policy?.timezone ?? DEFAULT_ZONE;
  const [month, setMonth] = useState(() => currentMonth(zone));
  const membership = directory.memberships.find((m) => m.id === employee.membership_id);
  const state = useLoader(() => rpc<EmployeeState>(client, 'get_employee_state', { p_organization_id: org, p_employee_id: employee.id }), [client, org, employee.id, employee.version]);
  const evidence = useLoader(() => loadEmployeeSessions(client, org, employee.id, directory.policies), [client, org, employee.id, directory.policies]);
  const sessions = sortSessions(evidence.data?.sessions ?? []).filter((s) => {
    const entry = s.effective[0]?.effective_at ?? s.originals[0]?.server_at;
    return entry && localDate(entry, s.timezone).startsWith(month);
  });
  useEffect(() => { document.getElementById('page-title')?.focus(); }, [employee.id]);

  return (
    <>
      <PageHeader title={`Ficha de ${employee.display_name}`}>
        <p>Código {employee.code} · {employee.active ? 'Activo' : 'Inactivo'} · {membership ? `Cuenta ${ROLE_LABEL[membership.role].toLowerCase()}` : 'Sin cuenta (kiosco)'}</p>
      </PageHeader>
      <div className="button-row">
        <button type="button" className="btn btn-secondary" onClick={onBack}>Volver a la lista</button>
        <button type="button" className="btn btn-secondary" onClick={() => { setStatus(null); setEditing(true); }}>Editar datos</button>
        <PinReset employee={employee} />
      </div>
      <LiveRegion tone="success" message={status} />
      <section aria-labelledby="state-title" className="subsection">
        <h2 id="state-title">Estado actual</h2>
        {state.loading && <Loading />}
        {state.error && <Notice tone="error" title={state.error} />}
        {state.data && (
          <p><strong>{STATE_LABEL[state.data.state]}</strong>{state.data.last_event_at ? ` · último fichaje ${formatDateTime(state.data.last_event_at, zone)}` : ' · sin fichajes'}</p>
        )}
      </section>
      <PolicyAssignmentForm employee={employee} directory={directory} onAssigned={(message) => { setStatus(message); onChanged(); }} />
      <section aria-labelledby="record-title" className="subsection">
        <h2 id="record-title">Registro de jornada</h2>
        <form className="filters" onSubmit={(e) => e.preventDefault()}>
          <Field label="Mes">{(p) => <input {...p} type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field>
        </form>
        {evidence.loading && <Loading />}
        {evidence.error && <Notice tone="error" title={evidence.error} />}
        {evidence.data && (sessions.length === 0 ? <EmptyState>No hay jornadas en este mes.</EmptyState>
          : sessions.map((s) => <SessionView key={s.id} session={s} />))}
      </section>
      {editing && (
        <EmployeeForm directory={directory} employee={employee} onClose={() => setEditing(false)}
          onSaved={(name) => { setEditing(false); setStatus(`Datos de «${name}» guardados.`); onChanged(); }} />
      )}
    </>
  );
}

function PolicyAssignmentForm({ employee, directory, onAssigned }: { employee: Employee; directory: Directory; onAssigned: (message: string) => void }) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const assignments = directory.assignments.filter((a) => a.employee_id === employee.id)
    .sort((a, b) => a.effective_from.localeCompare(b.effective_from));

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const policyId = String(form.get('policy') ?? '');
    const policy = directory.policies.find((p) => p.id === policyId);
    if (!policy) { setError('Elige un horario.'); return; }
    let effectiveFrom: string | null = null;
    if (when === 'later') {
      const candidates = zonedCandidates(String(form.get('date') ?? ''), String(form.get('time') ?? ''), policy.timezone);
      if (candidates.length !== 1 || candidates[0].getTime() <= Date.now()) { setError('Indica una fecha y hora futuras válidas.'); return; }
      effectiveFrom = candidates[0].toISOString();
    }
    const args = { p_organization_id: tenant.current.organization.id, p_employee_id: employee.id, p_policy_id: policyId, p_effective_from: effectiveFrom };
    const key = JSON.stringify(args);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'assign_work_policy', { ...args, p_request_id: requestId });
      attempt.current = null;
      onAssigned(`Horario v${policy.version} asignado${effectiveFrom ? ' con efecto futuro' : ' desde ahora'}. Las jornadas ya iniciadas conservan su horario.`);
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-labelledby="policy-title" className="subsection">
      <h2 id="policy-title">Horario</h2>
      {assignments.length === 0 ? <p>Sin horario asignado: no podrá fichar entrada hasta que se asigne uno.</p> : (
        <ul>
          {assignments.map((a) => {
            const p = directory.policies.find((x) => x.id === a.policy_id);
            return <li key={a.id}>Desde {formatDateTime(a.effective_from, p?.timezone ?? DEFAULT_ZONE)}: horario v{p?.version} ({p ? zoneLabel(p.timezone) : ''}, pausas {p?.break_counts_as_work ? 'computables' : 'no computables'})</li>;
          })}
        </ul>
      )}
      {directory.policies.length === 0 ? <p className="hint">Crea primero un horario en «Horarios».</p> : (
        <form noValidate onSubmit={submit} className="filters">
          <Field label="Asignar horario">
            {(p) => (
              <select {...p} name="policy" defaultValue={directory.policies[directory.policies.length - 1].id}>
                {directory.policies.map((x) => <option key={x.id} value={x.id}>v{x.version} · {zoneLabel(x.timezone)} · pausas {x.break_counts_as_work ? 'computables' : 'no computables'}</option>)}
              </select>
            )}
          </Field>
          <fieldset className="fieldset">
            <legend>Desde</legend>
            <label className="radio"><input type="radio" name="when" checked={when === 'now'} onChange={() => setWhen('now')} /> Ahora</label>
            <label className="radio"><input type="radio" name="when" checked={when === 'later'} onChange={() => setWhen('later')} /> Fecha futura</label>
            {when === 'later' && (
              <div className="inline-fields">
                <Field label="Fecha">{(p) => <input {...p} type="date" name="date" />}</Field>
                <Field label="Hora">{(p) => <input {...p} type="time" name="time" />}</Field>
              </div>
            )}
          </fieldset>
          <LiveRegion tone="error" message={error} />
          <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Asignando…' : 'Asignar horario'}</button>
        </form>
      )}
    </section>
  );
}

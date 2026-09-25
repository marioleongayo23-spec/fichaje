import { useRef, useState, type FormEvent } from 'react';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { newRequestId, rpc } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { formatDateTime, zoneLabel, ZONES } from '../lib/time';
import { EmptyState, Field, LiveRegion, Loading, Notice, PageHeader, TableWrap } from '../ui/components';
import { useDirectory } from './data';

// Policies are append-only and versioned by the server; a new version never
// changes sessions already started. Assignment is done from each employee file.
export function PoliciesPage() {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const directory = useDirectory();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const zone = String(form.get('zone') ?? '');
    const breaks = form.get('breaks');
    if (!zone || (breaks !== 'yes' && breaks !== 'no')) { setError('Elige la zona horaria y si las pausas computan.'); return; }
    const args = { p_organization_id: tenant.current.organization.id, p_timezone: zone, p_break_counts_as_work: breaks === 'yes' };
    const key = JSON.stringify(args);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true);
    setError(null);
    setStatus(null);
    try {
      const result = await rpc<{ version: number }>(client, 'create_work_policy', { ...args, p_request_id: requestId });
      attempt.current = null;
      setStatus(`Horario v${result.version} creado. Asígnalo desde la ficha de cada empleado.`);
      void directory.reload();
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader title="Horarios">
        <p>Cada horario fija la zona horaria y si las pausas computan como tiempo de trabajo. Se guardan como versiones; nunca se editan.</p>
      </PageHeader>
      <LiveRegion tone="success" message={status} />
      {directory.loading && <Loading />}
      {directory.error && <Notice tone="error" title={directory.error} />}
      {directory.data && (directory.data.policies.length === 0 ? <EmptyState>Todavía no hay horarios.</EmptyState> : (
        <TableWrap label="Versiones de horario">
          <table className="table">
            <caption className="visually-hidden">Versiones de horario</caption>
            <thead><tr><th scope="col">Versión</th><th scope="col">Zona</th><th scope="col">Pausas</th><th scope="col">Vigente desde</th><th scope="col">Personas asignadas</th></tr></thead>
            <tbody>
              {directory.data.policies.map((p) => (
                <tr key={p.id}>
                  <th scope="row">v{p.version}</th>
                  <td>{zoneLabel(p.timezone)}</td>
                  <td>{p.break_counts_as_work ? 'Computan como trabajo' : 'No computan'}</td>
                  <td>{formatDateTime(p.valid_from, p.timezone)}</td>
                  <td>{new Set(directory.data!.assignments.filter((a) => a.policy_id === p.id).map((a) => a.employee_id)).size}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ))}
      <section aria-labelledby="new-policy" className="subsection">
        <h2 id="new-policy">Nuevo horario</h2>
        <form noValidate onSubmit={submit}>
          <Field label="Zona horaria">
            {(p) => (
              <select {...p} name="zone" defaultValue="Europe/Madrid">
                {ZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
              </select>
            )}
          </Field>
          <fieldset className="fieldset">
            <legend>¿Las pausas computan como tiempo de trabajo?</legend>
            <p className="hint">Depende del convenio o del acuerdo de la empresa. No se aplica ninguna regla automática.</p>
            <label className="radio"><input type="radio" name="breaks" value="no" defaultChecked /> No computan</label>
            <label className="radio"><input type="radio" name="breaks" value="yes" /> Sí computan</label>
          </fieldset>
          <LiveRegion tone="error" message={error} />
          <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Creando…' : 'Crear horario'}</button>
        </form>
      </section>
    </>
  );
}

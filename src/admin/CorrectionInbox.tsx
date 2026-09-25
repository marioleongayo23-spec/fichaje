import { useRef, useState, type FormEvent } from 'react';
import { currentPolicy, useLoader } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { describeOperation, reasonError, REASON_MAX } from '../domain/corrections';
import type { EmployeeState, TimelineItem } from '../domain/types';
import { loadRequests, requestStatus, type RequestWithDecision } from '../employee/CorrectionsPage';
import { newRequestId, rpc } from '../lib/api';
import { asApiError, errorMessage } from '../lib/errors';
import { DEFAULT_ZONE, formatDateTime } from '../lib/time';
import { Dialog, EmptyState, Field, LiveRegion, Loading, Notice, PageHeader } from '../ui/components';
import { employeeName, useDirectory, type Directory } from './data';

interface Context { versions: Map<string, number>; timelines: Map<string, TimelineItem[]> }

export function CorrectionInbox() {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const directory = useDirectory();
  const [filter, setFilter] = useState<'pending' | 'decided'>('pending');
  const [deciding, setDeciding] = useState<{ item: RequestWithDecision; decision: 'APPROVE' | 'REJECT' } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const requests = useLoader(async () => {
    const list = await loadRequests(client, org);
    const employees = [...new Set(list.filter((r) => !r.decision).map((r) => r.request.employee_id))];
    const context: Context = { versions: new Map(), timelines: new Map() };
    await Promise.all(employees.map(async (id) => {
      const [state, timeline] = await Promise.all([
        rpc<EmployeeState>(client, 'get_employee_state', { p_organization_id: org, p_employee_id: id }),
        rpc<TimelineItem[]>(client, 'get_effective_timeline', { p_organization_id: org, p_employee_id: id }),
      ]);
      context.versions.set(id, state.version);
      context.timelines.set(id, timeline);
    }));
    return { list, context };
  }, [client, org]);

  const shown = requests.data?.list.filter((r) => (filter === 'pending') === !r.decision) ?? [];
  return (
    <>
      <PageHeader title="Solicitudes de corrección">
        <p>Decide sobre las correcciones propuestas. Debe decidir un gestor distinto de quien la solicitó y de la persona afectada; el servidor lo comprueba siempre.</p>
      </PageHeader>
      <fieldset className="fieldset segmented">
        <legend>Mostrar</legend>
        <label className="radio"><input type="radio" name="filter" checked={filter === 'pending'} onChange={() => setFilter('pending')} /> Pendientes</label>
        <label className="radio"><input type="radio" name="filter" checked={filter === 'decided'} onChange={() => setFilter('decided')} /> Decididas</label>
      </fieldset>
      <LiveRegion tone="success" message={status} />
      {(requests.loading || directory.loading) && <Loading />}
      {requests.error && <Notice tone="error" title={requests.error} />}
      {requests.data && directory.data && (shown.length === 0
        ? <EmptyState>{filter === 'pending' ? 'No hay solicitudes pendientes.' : 'No hay solicitudes decididas.'}</EmptyState>
        : (
          <ul className="card-list">
            {shown.map((item) => (
              <RequestCard key={item.request.id} item={item} directory={directory.data!} context={requests.data!.context} self={tenant.current.membership.id}
                onDecide={(decision) => { setStatus(null); setDeciding({ item, decision }); }} />
            ))}
          </ul>
        ))}
      {deciding && (
        <DecisionDialog item={deciding.item} decision={deciding.decision} onClose={() => setDeciding(null)}
          onDone={(message) => { setDeciding(null); setStatus(message); void requests.reload(); }} />
      )}
    </>
  );
}

function RequestCard({ item, directory, context, self, onDecide }: {
  item: RequestWithDecision; directory: Directory; context: Context; self: string; onDecide: (decision: 'APPROVE' | 'REJECT') => void;
}) {
  const { request, decision } = item;
  const employee = directory.employees.find((e) => e.id === request.employee_id);
  const zone = currentPolicy(directory.policies, directory.assignments.filter((a) => a.employee_id === request.employee_id))?.timezone ?? DEFAULT_ZONE;
  const requester = request.submitted_by_membership_id === employee?.membership_id
    ? 'la propia persona' : employeeName(directory, request.submitted_by_membership_id) ?? 'un gestor';
  const current = context.versions.get(request.employee_id);
  const stale = !decision && current !== undefined && current !== request.base_version;
  const involved = request.submitted_by_membership_id === self || employee?.membership_id === self || request.affected_membership_id === self;
  const items = context.timelines.get(request.employee_id) ?? [];
  const headingId = `request-${request.id}`;
  return (
    <li className="card">
      <article aria-labelledby={headingId}>
        <h2 className="card-title" id={headingId}>{employee ? `${employee.display_name} (${employee.code})` : 'Empleado'} {requestStatus(decision)}</h2>
        <p>Solicitada el {formatDateTime(request.created_at, zone)} por {requester}.</p>
        <h3 className="small-heading">Propuesta</h3>
        <ul className="review-list">
          {request.proposal.map((op, index) => <li key={index}>{describeOperation(op, items, op.timezone ?? zone)}</li>)}
        </ul>
        <p><strong>Motivo:</strong> {request.reason}</p>
        {decision ? (
          <p><strong>{decision.decision === 'APPROVE' ? 'Aprobada' : 'Rechazada'} el {formatDateTime(decision.created_at, zone)}:</strong> {decision.reason}</p>
        ) : stale ? (
          <Notice tone="warning" title="Solicitud obsoleta: el registro de la persona ha cambiado después de enviarla.">
            <p>No puede aprobarse ni rechazarse; debe presentarse una nueva solicitud sobre el registro actual.</p>
          </Notice>
        ) : involved ? (
          <Notice tone="info" title="No puedes decidir esta solicitud.">
            <p>La has presentado tú o te afecta a ti. Debe decidirla otro gestor autorizado.</p>
          </Notice>
        ) : (
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={() => onDecide('APPROVE')}>Aprobar<span className="visually-hidden"> solicitud de {employee?.display_name}</span></button>
            <button type="button" className="btn btn-danger" onClick={() => onDecide('REJECT')}>Rechazar<span className="visually-hidden"> solicitud de {employee?.display_name}</span></button>
          </div>
        )}
      </article>
    </li>
  );
}

function DecisionDialog({ item, decision, onClose, onDone }: {
  item: RequestWithDecision; decision: 'APPROVE' | 'REJECT'; onClose: () => void; onDone: (message: string) => void;
}) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const [reason, setReason] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const approve = decision === 'APPROVE';
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const invalid = reasonError(reason);
    setFieldError(invalid);
    if (invalid) return;
    const args = { p_organization_id: tenant.current.organization.id, p_correction_request_id: item.request.id, p_decision: decision, p_reason: reason.trim() };
    const key = JSON.stringify(args);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'decide_correction', { ...args, p_request_id: requestId });
      onDone(approve ? 'Corrección aprobada. Los fichajes originales se conservan; el registro vigente se ha actualizado.' : 'Corrección rechazada. El registro no cambia.');
    } catch (failure) {
      const apiError = asApiError(failure);
      if (apiError.kind === 'forbidden') {
        setError('El servidor no te permite decidir esta solicitud: debe hacerlo un gestor distinto de quien la solicitó, de la persona afectada y de quien fichó en su nombre.');
        void tenant.reload();
      } else if (apiError.code === 'VERSION_CONFLICT') {
        setError('El registro de la persona cambió después de la solicitud. Ya no puede decidirse; debe presentarse una nueva.');
      } else if (apiError.kind === 'network' || apiError.kind === 'timeout') {
        setError('No sabemos si la decisión se registró. Pulsa el botón de nuevo: se reenvía la misma decisión sin duplicarla.');
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open title={approve ? 'Aprobar corrección' : 'Rechazar corrección'} onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <p>{approve ? 'Al aprobar se añaden los ajustes propuestos; los fichajes originales no se modifican.' : 'Al rechazar, el registro queda como está.'} La decisión queda registrada y no se puede deshacer.</p>
        <Field label="Motivo de la decisión (obligatorio)" error={fieldError}>
          {(p) => <textarea {...p} rows={3} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <LiveRegion tone="error" message={error} />
        <div className="button-row">
          <button type="submit" className={approve ? 'btn btn-primary' : 'btn btn-danger'} disabled={pending}>
            {pending ? 'Enviando…' : approve ? 'Confirmar aprobación' : 'Confirmar rechazo'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Dialog>
  );
}

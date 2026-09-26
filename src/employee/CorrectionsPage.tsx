import { useState } from 'react';
import { useLoader, usePolicies } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { describeOperation } from '../domain/corrections';
import type { CorrectionDecision, CorrectionRequest } from '../domain/types';
import { select } from '../lib/api';
import { DEFAULT_ZONE, formatDateTime } from '../lib/time';
import { Badge, EmptyState, LiveRegion, Loading, Notice, PageHeader } from '../ui/components';
import { CorrectionDialog } from './CorrectionDialog';

export interface RequestWithDecision { request: CorrectionRequest; decision: CorrectionDecision | null }

export function requestStatus(decision: CorrectionDecision | null) {
  if (!decision) return <Badge tone="warning">Pendiente</Badge>;
  return decision.decision === 'APPROVE' ? <Badge tone="success">Aprobada</Badge> : <Badge tone="danger">Rechazada</Badge>;
}

export async function loadRequests(client: ReturnType<typeof useServices>['client'], org: string, employeeId?: string): Promise<RequestWithDecision[]> {
  let query = client.from('correction_requests')
    .select('id,employee_id,submitted_by_membership_id,affected_membership_id,base_version,reason,proposal,created_at')
    .eq('organization_id', org).order('created_at', { ascending: false }).limit(200);
  if (employeeId) query = query.eq('employee_id', employeeId);
  const requests = await select<CorrectionRequest>(query);
  const decisions = requests.length ? await select<CorrectionDecision>(client.from('correction_decisions')
    .select('id,request_id,employee_id,decision,actor_membership_id,reason,created_at').eq('organization_id', org)
    .in('request_id', requests.map((r) => r.id))) : [];
  return requests.map((request) => ({ request, decision: decisions.find((d) => d.request_id === request.id) ?? null }));
}

export function ProposalList({ request, zone }: { request: CorrectionRequest; zone: string }) {
  return (
    <ul className="review-list">
      {request.proposal.map((op, index) => <li key={index}>{describeOperation(op, [], op.timezone ?? zone)}</li>)}
    </ul>
  );
}

export function CorrectionsPage() {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const employee = tenant.current.employee;
  const org = tenant.current.organization.id;
  const policies = usePolicies(employee?.id ?? null);
  const zone = policies.data?.current?.timezone ?? DEFAULT_ZONE;
  const [adding, setAdding] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const requests = useLoader(async () => employee ? loadRequests(client, org, employee.id) : [], [client, org, employee?.id]);

  if (!employee) {
    return (<><PageHeader title="Mis correcciones" /><Notice tone="info" title="Tu cuenta no tiene ficha de empleado en esta organización." /></>);
  }
  return (
    <>
      <PageHeader title="Mis correcciones">
        <p>Solicitudes para corregir tu registro. Para corregir una jornada concreta, ábrela en «Mi registro».</p>
      </PageHeader>
      <button type="button" className="btn btn-secondary" onClick={() => { setSubmitted(null); setAdding(true); }}>Añadir una jornada que falta</button>
      <LiveRegion tone="success" message={submitted} />
      {requests.loading && <Loading />}
      {requests.error && <Notice tone="error" title={requests.error} />}
      {requests.data && (
        requests.data.length === 0 ? <EmptyState>No has enviado solicitudes de corrección.</EmptyState> : (
          <ul className="card-list">
            {requests.data.map(({ request, decision }) => (
              <li key={request.id} className="card">
                <h2 className="card-title">Solicitud del {formatDateTime(request.created_at, zone)} {requestStatus(decision)}</h2>
                <ProposalList request={request} zone={zone} />
                <p><strong>Motivo:</strong> {request.reason}</p>
                {decision && <p><strong>Decisión ({formatDateTime(decision.created_at, zone)}):</strong> {decision.reason}</p>}
              </li>
            ))}
          </ul>
        )
      )}
      {adding && (
        <CorrectionDialog open employeeId={employee.id} session={null} knownItems={[]} newSessionZone={zone}
          onClose={() => setAdding(false)} onSubmitted={(message) => { setAdding(false); setSubmitted(message); void requests.reload(); }} />
      )}
    </>
  );
}

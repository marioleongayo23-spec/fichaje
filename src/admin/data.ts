import type { SupabaseClient } from '@supabase/supabase-js';
import { useLoader } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import type { EvidenceSession, OriginalEvent, Adjustment } from '../domain/evidence';
import type { CorrectionDecision, CorrectionRequest, Employee, Membership, PolicyAssignment, TimelineItem, WorkPolicy, WorkSession } from '../domain/types';
import { postJson, rpc, select } from '../lib/api';
import { ApiError } from '../lib/errors';

export interface Directory { employees: Employee[]; memberships: Membership[]; policies: WorkPolicy[]; assignments: PolicyAssignment[] }

// Tenant directory for managers. Every query filters by the selected
// organization explicitly; RLS remains the authority.
export function useDirectory() {
  const { client } = useServices();
  const org = useCurrentTenant().current.organization.id;
  return useLoader<Directory>(async () => {
    const [employees, memberships, policies, assignments] = await Promise.all([
      select<Employee>(client.from('employees').select('id,organization_id,code,display_name,membership_id,active,version,created_at').eq('organization_id', org).order('display_name')),
      select<Membership>(client.from('memberships').select('id,organization_id,auth_user_id,role,active,version,created_at').eq('organization_id', org).order('created_at')),
      select<WorkPolicy>(client.from('work_policies').select('id,organization_id,version,timezone,break_counts_as_work,valid_from,created_at').eq('organization_id', org).order('version')),
      select<PolicyAssignment>(client.from('employee_policy_assignments').select('id,employee_id,policy_id,effective_from,created_at').eq('organization_id', org)),
    ]);
    return { employees, memberships, policies, assignments };
  }, [client, org]);
}

export function employeeName(directory: Directory | undefined, membershipId: string | null): string | null {
  if (!directory || !membershipId) return null;
  return directory.employees.find((e) => e.membership_id === membershipId)?.display_name ?? null;
}

// Full evidence of one employee for a manager, assembled from RLS-readable
// tables and the effective timeline RPC (same data the H5 snapshot uses).
export async function loadEmployeeSessions(client: SupabaseClient, org: string, employeeId: string, policies: WorkPolicy[]): Promise<{ sessions: EvidenceSession[]; timeline: TimelineItem[]; workSessions: WorkSession[] }> {
  const [timeline, workSessions, originals, adjustments] = await Promise.all([
    rpc<TimelineItem[]>(client, 'get_effective_timeline', { p_organization_id: org, p_employee_id: employeeId }),
    select<WorkSession>(client.from('work_sessions').select('id,employee_id,policy_id,timezone,created_at').eq('organization_id', org).eq('employee_id', employeeId)),
    select<OriginalEvent>(client.from('time_events').select('id,session_id,sequence,event_type,server_at,source,actor_membership_id,kiosk_device_id').eq('organization_id', org).eq('employee_id', employeeId)),
    select<Adjustment & { decision_id: string }>(client.from('event_adjustments').select('id,operation,target_event_id,supersedes_adjustment_id,effective_at,event_type,session_id,ordinal,created_at,decision_id').eq('organization_id', org).eq('employee_id', employeeId)),
  ]);
  const decisions = adjustments.length ? await select<CorrectionDecision>(client.from('correction_decisions')
    .select('id,request_id,employee_id,decision,actor_membership_id,reason,created_at').eq('organization_id', org).eq('employee_id', employeeId)) : [];
  const requests = decisions.length ? await select<CorrectionRequest>(client.from('correction_requests')
    .select('id,employee_id,submitted_by_membership_id,affected_membership_id,base_version,reason,proposal,created_at').eq('organization_id', org).eq('employee_id', employeeId)) : [];
  const sessions = workSessions.flatMap((ws): EvidenceSession[] => {
    const policy = policies.find((p) => p.id === ws.policy_id);
    if (!policy) return [];
    return [{
      id: ws.id, timezone: ws.timezone, policy,
      originals: originals.filter((o) => o.session_id === ws.id),
      adjustments: adjustments.filter((a) => a.session_id === ws.id).flatMap((adjustment) => {
        const decision = decisions.find((d) => d.id === adjustment.decision_id);
        const request = requests.find((r) => r.id === decision?.request_id);
        return decision && request ? [{ adjustment, decision, request }] : [];
      }),
      effective: timeline.filter((t) => t.session_id === ws.id),
    }];
  });
  return { sessions, timeline, workSessions };
}

// Manager operations of the H4 gateway (provision/revoke/reset). Responses are
// generic on failure by design; nothing here is logged.
export async function gateway<T>(client: SupabaseClient, baseUrl: string, route: 'provision' | 'revoke' | 'reset', body: Record<string, unknown>): Promise<T> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new ApiError('unauthenticated', 'UNAUTHENTICATED');
  return postJson<T>(`${baseUrl}/${route}`, token, body);
}

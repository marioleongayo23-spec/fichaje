import { useCallback, useEffect, useRef, useState } from 'react';
import { select } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { toDate } from '../lib/time';
import type { PolicyAssignment, WorkPolicy } from '../domain/types';
import { useServices } from './services';
import { useCurrentTenant, useTenant } from './tenant';

export interface Loaded<T> { data: T | undefined; error: string | null; loading: boolean; reload: () => Promise<void> }

// Loads tenant-scoped data. Results live in component memory only; a failed
// refresh drops previous data instead of showing stale records as current.
export function useLoader<T>(load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const { handleError } = useTenant();
  const [state, setState] = useState<{ data: T | undefined; error: string | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const counter = useRef(0);
  const run = useCallback(load, deps);
  const reload = useCallback(async () => {
    const id = ++counter.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const data = await run();
      if (id === counter.current) setState({ data, error: null, loading: false });
    } catch (failure) {
      handleError(failure);
      if (id === counter.current) setState({ data: undefined, error: errorMessage(failure), loading: false });
    }
  }, [run, handleError]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}

export interface PolicyInfo { policies: WorkPolicy[]; assignments: PolicyAssignment[]; current: WorkPolicy | null }

export function currentPolicy(policies: WorkPolicy[], assignments: PolicyAssignment[], now = Date.now()): WorkPolicy | null {
  const active = [...assignments].sort((a, b) => toDate(b.effective_from).getTime() - toDate(a.effective_from).getTime())
    .find((a) => toDate(a.effective_from).getTime() <= now);
  return policies.find((p) => p.id === active?.policy_id) ?? null;
}

export function usePolicies(employeeId: string | null): Loaded<PolicyInfo> {
  const { client } = useServices();
  const { current } = useCurrentTenant();
  const org = current.organization.id;
  return useLoader(async () => {
    const policies = await select<WorkPolicy>(client.from('work_policies')
      .select('id,organization_id,version,timezone,break_counts_as_work,valid_from,created_at').eq('organization_id', org).order('version'));
    const assignments = employeeId ? await select<PolicyAssignment>(client.from('employee_policy_assignments')
      .select('id,employee_id,policy_id,effective_from,created_at').eq('organization_id', org).eq('employee_id', employeeId)) : [];
    return { policies, assignments, current: currentPolicy(policies, assignments) };
  }, [client, org, employeeId]);
}

export function useNow(intervalMs = 1000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

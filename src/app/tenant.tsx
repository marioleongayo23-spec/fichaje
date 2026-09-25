import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { select } from '../lib/api';
import { asApiError, errorMessage } from '../lib/errors';
import type { Employee, Membership, Organization, Role } from '../domain/types';
import { useAuth } from './auth';
import { useServices } from './services';

export interface TenantEntry { organization: Organization; membership: Membership; employee: Employee | null }
interface TenantValue {
  loading: boolean; error: string | null; notice: string | null;
  entries: TenantEntry[]; current: TenantEntry | null; role: Role | null; userId: string;
  select: (organizationId: string) => void; clear: () => void; reload: () => Promise<void>;
  handleError: (error: unknown) => void;
}
const TenantContext = createContext<TenantValue | null>(null);

// The selected organization is a UI preference kept in memory only. Access is
// revalidated against the database (RLS) on load, focus, reconnect and on any
// authorization failure; a revoked tenant disappears and its state is dropped.
export function TenantProvider({ children }: { children: ReactNode }) {
  const { client } = useServices();
  const { session, signOut } = useAuth();
  const userId = session?.user.id ?? '';
  const [entries, setEntries] = useState<TenantEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  useEffect(() => { selectedRef.current = selected; }, [selected]);

  const reload = useCallback(async () => {
    if (!userId) return;
    try {
      const memberships = await select<Membership>(client.from('memberships')
        .select('id,organization_id,auth_user_id,role,active,version,created_at').eq('auth_user_id', userId).eq('active', true));
      const organizations = memberships.length ? await select<Organization>(client.from('organizations')
        .select('id,name,status').in('id', memberships.map((m) => m.organization_id))) : [];
      const employees = memberships.length ? await select<Employee>(client.from('employees')
        .select('id,organization_id,code,display_name,membership_id,active,version,created_at').in('membership_id', memberships.map((m) => m.id))) : [];
      const next = memberships.flatMap((membership) => {
        const organization = organizations.find((o) => o.id === membership.organization_id && o.status === 'ACTIVE');
        if (!organization) return [];
        return [{ organization, membership, employee: employees.find((e) => e.membership_id === membership.id) ?? null }];
      }).sort((a, b) => a.organization.name.localeCompare(b.organization.name, 'es'));
      setEntries(next);
      setError(null);
      const current = selectedRef.current;
      if (current && !next.some((e) => e.organization.id === current)) {
        setSelected(null);
        setNotice('Tu acceso a la organización seleccionada ha cambiado o se ha retirado. Se han descartado sus datos en pantalla.');
      } else if (!current && next.length === 1) {
        setSelected(next[0].organization.id);
      }
    } catch (failure) {
      const apiError = asApiError(failure);
      if (apiError.kind === 'unauthenticated') {
        await signOut('Tu sesión ha caducado. Vuelve a iniciar sesión.');
        return;
      }
      setError(errorMessage(apiError));
    } finally {
      setLoading(false);
    }
  }, [client, userId, signOut]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const revalidate = () => { if (document.visibilityState === 'visible' && navigator.onLine) void reload(); };
    document.addEventListener('visibilitychange', revalidate);
    window.addEventListener('online', revalidate);
    return () => {
      document.removeEventListener('visibilitychange', revalidate);
      window.removeEventListener('online', revalidate);
    };
  }, [reload]);

  const handleError = useCallback((failure: unknown) => {
    const apiError = asApiError(failure);
    if (apiError.kind === 'unauthenticated') void signOut('Tu sesión ha caducado. Vuelve a iniciar sesión.');
    else if (apiError.kind === 'forbidden') void reload();
  }, [reload, signOut]);

  const value = useMemo<TenantValue>(() => {
    const current = entries.find((e) => e.organization.id === selected) ?? null;
    return {
      loading, error, notice, entries, current, role: current?.membership.role ?? null, userId,
      select: (id: string) => { setNotice(null); setSelected(id); },
      clear: () => { setNotice(null); setSelected(null); },
      reload, handleError,
    };
  }, [entries, selected, loading, error, notice, userId, reload, handleError]);
  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
}

export function useTenant(): TenantValue {
  const value = useContext(TenantContext);
  if (!value) throw new Error('Tenant unavailable');
  return value;
}

// Pages below the tenant gate always have a current organization.
export function useCurrentTenant(): TenantValue & { current: TenantEntry; role: Role } {
  const value = useTenant();
  if (!value.current || !value.role) throw new Error('No organization selected');
  return value as TenantValue & { current: TenantEntry; role: Role };
}

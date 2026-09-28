import { useEffect, useMemo, type ReactNode } from 'react';
import { ClassificationsPage } from './admin/ClassificationsPage';
import { CorrectionInbox } from './admin/CorrectionInbox';
import { DevicesPage } from './admin/DevicesPage';
import { EmployeesPage } from './admin/EmployeesPage';
import { ExportsPage, OwnExportPage } from './admin/ExportsPage';
import { MembersPage } from './admin/MembersPage';
import { PoliciesPage } from './admin/PoliciesPage';
import { AuthProvider, useAuth } from './app/auth';
import { Layout } from './app/Layout';
import { LoginPage } from './app/LoginPage';
import { OrganizationPicker } from './app/OrganizationPicker';
import { RouterProvider, useRouter } from './app/router';
import { ServicesContext } from './app/services';
import { TenantProvider, useCurrentTenant, useTenant } from './app/tenant';
import { readAppConfig, type AppConfig, type AppEnvironment } from './config';
import { isManager } from './domain/labels';
import { ClockPage } from './employee/ClockPage';
import { CorrectionsPage } from './employee/CorrectionsPage';
import { EvidencePage } from './employee/EvidencePage';
import { KioskApp } from './kiosk/KioskApp';
import { useOnline } from './lib/online';
import { HUMAN_STORAGE_KEY } from './lib/storage';
import { createSessionClient } from './lib/supabase';
import { startTelemetry } from './lib/telemetry';
import { Loading, Notice, PageHeader } from './ui/components';
import { ErrorBoundary } from './ui/ErrorBoundary';

function Unconfigured({ invalid }: { invalid?: boolean }) {
  return (
    <main id="contenido" className="auth-page">
      <div className="auth-card">
        <h1>Fichaje APP</h1>
        <p>{invalid ? 'La configuración pública del servicio no es válida.' : 'Sin servicio de fichaje activo: falta la configuración pública del servicio.'}</p>
      </div>
    </main>
  );
}

export function App({ env = import.meta.env as AppEnvironment }: { env?: AppEnvironment }) {
  let config: AppConfig | null;
  try {
    config = readAppConfig(env);
  } catch {
    return <Unconfigured invalid />;
  }
  if (!config) return <Unconfigured />;
  return <ErrorBoundary>{window.location.pathname === '/kiosco' ? <KioskApp config={config} /> : <HumanApp config={config} />}</ErrorBoundary>;
}

function HumanApp({ config }: { config: AppConfig }) {
  const services = useMemo(() => ({ config, client: createSessionClient(config.supabase, HUMAN_STORAGE_KEY, window.localStorage) }), [config]);
  useEffect(() => startTelemetry(services.client), [services.client]);
  return (
    <ServicesContext.Provider value={services}>
      <RouterProvider>
        <AuthProvider><Session /></AuthProvider>
      </RouterProvider>
    </ServicesContext.Provider>
  );
}

function Session() {
  const auth = useAuth();
  const { navigate } = useRouter();
  // A new sign-in always starts at the home route, never at the previous user's page.
  useEffect(() => { if (!auth.loading && !auth.session) navigate('/'); }, [auth.loading, auth.session, navigate]);
  if (auth.loading) return <main id="contenido" className="auth-page"><Loading label="Comprobando la sesión…" /></main>;
  if (!auth.session) return <LoginPage />;
  return <TenantProvider key={auth.session.user.id}><TenantGate /></TenantProvider>;
}

function TenantGate() {
  const tenant = useTenant();
  if (tenant.loading) return <main id="contenido" className="auth-page"><Loading label="Cargando tus organizaciones…" /></main>;
  if (!tenant.current && tenant.error) return <ConnectionProblem message={tenant.error} retry={() => void tenant.reload()} />;
  if (!tenant.current) return <OrganizationPicker />;
  // Keyed by organization: switching tenant discards all tenant-dependent state.
  return <Layout key={tenant.current.organization.id}><Routes /></Layout>;
}

// Without the server nothing tenant-related is shown: no cached records exist.
function ConnectionProblem({ message, retry }: { message: string; retry: () => void }) {
  const { signOut } = useAuth();
  const online = useOnline();
  return (
    <main id="contenido" className="auth-page">
      <div className="auth-card">
        <h1>No se pueden cargar tus datos</h1>
        <Notice tone="warning" title={online ? message : 'Sin conexión.'}>
          <p>No se puede fichar ni consultar datos sin conexión. Si necesitas registrar tu jornada ahora, sigue el procedimiento de contingencia de tu empresa y solicita después una corrección.</p>
        </Notice>
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={retry} disabled={!online}>Reintentar</button>
          <button type="button" className="btn btn-secondary" onClick={() => void signOut()}>Cerrar sesión</button>
        </div>
      </div>
    </main>
  );
}

function Guard({ allowed, children }: { allowed: boolean; children: ReactNode }) {
  if (allowed) return <>{children}</>;
  return (<><PageHeader title="Sin acceso" /><Notice tone="info" title="Esta sección no está disponible con tu rol en esta organización." /></>);
}

function Routes() {
  const { path } = useRouter();
  const tenant = useCurrentTenant();
  const manager = isManager(tenant.role);
  const own = tenant.current.employee !== null;
  switch (path) {
    case '/': return own || !manager ? <ClockPage /> : <EmployeesPage />;
    case '/registro': return <EvidencePage />;
    case '/correcciones': return <CorrectionsPage />;
    case '/exportar': return <OwnExportPage />;
    case '/gestion/empleados': return <Guard allowed={manager}><EmployeesPage /></Guard>;
    case '/gestion/personas': return <Guard allowed={manager}><MembersPage /></Guard>;
    case '/gestion/horarios': return <Guard allowed={manager}><PoliciesPage /></Guard>;
    case '/gestion/correcciones': return <Guard allowed={manager}><CorrectionInbox /></Guard>;
    case '/gestion/horas': return <Guard allowed={manager}><ClassificationsPage /></Guard>;
    case '/gestion/exportaciones': return <Guard allowed={manager}><ExportsPage /></Guard>;
    case '/gestion/kioscos': return <Guard allowed={manager}><DevicesPage /></Guard>;
    default: return (<><PageHeader title="Página no encontrada" /><Notice tone="info" title="La dirección no existe. Usa el menú para continuar." /></>);
  }
}

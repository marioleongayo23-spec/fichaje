import { useEffect, useState, type ReactNode } from 'react';
import { BRAND } from '../config';
import { isManager, ROLE_LABEL } from '../domain/labels';
import { useOnline } from '../lib/online';
import { useAuth } from './auth';
import { Link, useRouter } from './router';
import { useCurrentTenant } from './tenant';

type NavIconName = 'clock' | 'hours' | 'edit' | 'download' | 'team' | 'people' | 'calendar' | 'approve' | 'chart' | 'reports' | 'kiosk';

export const PERSONAL_NAV = [
  { to: '/', label: 'Fichar', icon: 'clock' },
  { to: '/registro', label: 'Mi registro', icon: 'hours' },
  { to: '/correcciones', label: 'Mis correcciones', icon: 'edit' },
  { to: '/exportar', label: 'Exportar mi registro', icon: 'download' },
] satisfies { to: string; label: string; icon: NavIconName }[];

export const MANAGEMENT_NAV = [
  { to: '/gestion/empleados', label: 'Empleados', icon: 'team' },
  { to: '/gestion/personas', label: 'Personas y roles', icon: 'people' },
  { to: '/gestion/horarios', label: 'Horarios', icon: 'calendar' },
  { to: '/gestion/correcciones', label: 'Solicitudes de corrección', icon: 'approve' },
  { to: '/gestion/horas', label: 'Clasificación de horas', icon: 'chart' },
  { to: '/gestion/exportaciones', label: 'Exportaciones', icon: 'reports' },
  { to: '/gestion/kioscos', label: 'Kioscos', icon: 'kiosk' },
] satisfies { to: string; label: string; icon: NavIconName }[];

function NavIcon({ name }: { name: NavIconName }) {
  const p = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'clock': return <svg {...p}><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>;
    case 'hours': return <svg {...p}><path d="M7 3h8l3 3v15H7z" /><path d="M15 3v4h4M10 12h5M10 16h5" /></svg>;
    case 'edit': return <svg {...p}><path d="M4 20h4l11-11-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>;
    case 'download': return <svg {...p}><path d="M12 3v12" /><path d="m8 11 4 4 4-4" /><path d="M5 20h14" /></svg>;
    case 'team': return <svg {...p}><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2" /><path d="M3.5 20c.7-4 2.5-6 5.5-6s4.8 2 5.5 6M14 15c2.8 0 4.7 1.7 5.5 5" /></svg>;
    case 'people': return <svg {...p}><circle cx="8" cy="8" r="3" /><circle cx="16" cy="8" r="3" /><path d="M2.5 20c.8-4 2.6-6 5.5-6M21.5 20c-.8-4-2.6-6-5.5-6M10 20c.4-3 1.1-5 2-6 .9 1 1.6 3 2 6" /></svg>;
    case 'calendar': return <svg {...p}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 9h16" /></svg>;
    case 'approve': return <svg {...p}><path d="M7 3h10v18H7z" /><path d="m9.5 13 1.8 1.8 3.7-4.2" /></svg>;
    case 'chart': return <svg {...p}><path d="M5 20V10M12 20V4M19 20v-7" /></svg>;
    case 'reports': return <svg {...p}><path d="M5 4h14v16H5z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;
    case 'kiosk': return <svg {...p}><rect x="5" y="3" width="14" height="16" rx="2" /><path d="M9 22h6M12 19v3M9 7h6" /></svg>;
  }
}

function NavItems({ items }: { items: { to: string; label: string; icon: NavIconName }[] }) {
  return (
    <>
      {items.map((item) => (
        <li key={item.to}>
          <Link to={item.to}>
            <span className="nav-icon"><NavIcon name={item.icon} /></span>
            <span className="nav-label">{item.label}</span>
          </Link>
        </li>
      ))}
    </>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const tenant = useCurrentTenant();
  const { signOut } = useAuth();
  const { path } = useRouter();
  const online = useOnline();
  const [menuOpen, setMenuOpen] = useState(false);
  const personal = tenant.current.employee !== null;
  const manager = isManager(tenant.role);

  useEffect(() => {
    setMenuOpen(false);
    const title = document.getElementById('page-title');
    if (title && document.activeElement !== title) title.focus();
  }, [path]);

  return (
    <div className="app">
      <a className="skip-link" href="#contenido">Saltar al contenido principal</a>
      <header className="app-header">
        <div className="app-header-inner">
          <div className="header-brand-cluster">
            <p className="brand-mark bundy-header-wordmark" role="img" aria-label={BRAND} />
            <span className="header-divider" aria-hidden="true" />
            <div className="org-info">
              <span className="org-kicker">Espacio de trabajo</span>
              <span className="org-name">{tenant.current.organization.name}</span>
            </div>
          </div>
          <div className="header-actions">
            <span className="role-chip">{ROLE_LABEL[tenant.role]}</span>
            {tenant.entries.length > 1 && (
              <button type="button" className="btn btn-link" onClick={tenant.clear}>Cambiar organización</button>
            )}
            <button type="button" className="btn btn-link header-signout" onClick={() => void signOut()}>Cerrar sesión</button>
          </div>
        </div>
      </header>

      <nav aria-label="Principal" className="app-nav" data-open={menuOpen ? 'true' : 'false'}>
        <button type="button" className="btn btn-secondary nav-toggle" aria-expanded={menuOpen} aria-controls="nav-sections"
          onClick={() => setMenuOpen((open) => !open)}>
          {menuOpen ? 'Cerrar menú' : 'Menú'}
        </button>
        <div id="nav-sections" className="nav-sections" onClick={(event) => { if ((event.target as Element).closest('a')) setMenuOpen(false); }}>
          {personal && (
            <div className="nav-group">
              <p className="nav-group-title" id="nav-personal">Mi jornada</p>
              <ul aria-labelledby="nav-personal"><NavItems items={PERSONAL_NAV} /></ul>
            </div>
          )}
          {manager && (
            <div className="nav-group">
              <p className="nav-group-title" id="nav-management">Gestión</p>
              <ul aria-labelledby="nav-management"><NavItems items={MANAGEMENT_NAV} /></ul>
            </div>
          )}
          <div className="nav-footer" aria-hidden="true">
            <span className="nav-footer-dot" />
            <span>Bundy · entorno seguro</span>
          </div>
        </div>
      </nav>

      <div role="status" className="live-region">
        {!online && (
          <p className="offline-banner">
            <strong>Sin conexión.</strong> No se puede fichar ni consultar datos. Si necesitas registrar tu jornada ahora,
            sigue el procedimiento de contingencia de tu empresa y solicita después una corrección.
          </p>
        )}
      </div>
      <main id="contenido" tabIndex={-1} className="app-main">{children}</main>
    </div>
  );
}

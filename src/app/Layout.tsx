import { useEffect, useState, type ReactNode } from 'react';
import { BRAND } from '../config';
import { isManager, ROLE_LABEL } from '../domain/labels';
import { useOnline } from '../lib/online';
import { useAuth } from './auth';
import { Link, useRouter } from './router';
import { useCurrentTenant } from './tenant';

export const PERSONAL_NAV = [
  { to: '/', label: 'Fichar' },
  { to: '/registro', label: 'Mi registro' },
  { to: '/correcciones', label: 'Mis correcciones' },
  { to: '/exportar', label: 'Exportar mi registro' },
];
export const MANAGEMENT_NAV = [
  { to: '/gestion/empleados', label: 'Empleados' },
  { to: '/gestion/personas', label: 'Personas y roles' },
  { to: '/gestion/horarios', label: 'Horarios' },
  { to: '/gestion/correcciones', label: 'Solicitudes de corrección' },
  { to: '/gestion/horas', label: 'Clasificación de horas' },
  { to: '/gestion/exportaciones', label: 'Exportaciones' },
  { to: '/gestion/kioscos', label: 'Kioscos' },
];

export function Layout({ children }: { children: ReactNode }) {
  const tenant = useCurrentTenant();
  const { signOut } = useAuth();
  const { path } = useRouter();
  const online = useOnline();
  const [menuOpen, setMenuOpen] = useState(false);
  const personal = tenant.current.employee !== null;
  const manager = isManager(tenant.role);

  // Route change: close the mobile menu and move focus to the page title.
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
          <p className="brand-mark bundy-header-wordmark" role="img" aria-label={BRAND} />
          <div className="org-info">
            <span className="org-name">{tenant.current.organization.name}</span>
            <span className="org-role">{ROLE_LABEL[tenant.role]}</span>
          </div>
          <div className="header-actions">
            {tenant.entries.length > 1 && (
              <button type="button" className="btn btn-link" onClick={tenant.clear}>Cambiar organización</button>
            )}
            <button type="button" className="btn btn-link" onClick={() => void signOut()}>Cerrar sesión</button>
          </div>
        </div>
      </header>
      <nav aria-label="Principal" className="app-nav" data-open={menuOpen ? 'true' : 'false'}>
        <button type="button" className="btn btn-secondary nav-toggle" aria-expanded={menuOpen} aria-controls="nav-sections"
          onClick={() => setMenuOpen((open) => !open)}>
          {menuOpen ? 'Cerrar menú' : 'Menú'}
        </button>
        {/* Choosing any destination (even the current page) closes the mobile menu. */}
        <div id="nav-sections" className="nav-sections" onClick={(event) => { if ((event.target as Element).closest('a')) setMenuOpen(false); }}>
          {personal && (
            <div className="nav-group">
              <p className="nav-group-title" id="nav-personal">Mi jornada</p>
              <ul aria-labelledby="nav-personal">
                {PERSONAL_NAV.map((item) => <li key={item.to}><Link to={item.to}>{item.label}</Link></li>)}
              </ul>
            </div>
          )}
          {manager && (
            <div className="nav-group">
              <p className="nav-group-title" id="nav-management">Gestión</p>
              <ul aria-labelledby="nav-management">
                {MANAGEMENT_NAV.map((item) => <li key={item.to}><Link to={item.to}>{item.label}</Link></li>)}
              </ul>
            </div>
          )}
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

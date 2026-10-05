import type { ReactNode } from 'react';
import { Link } from '../app/router';

function Icon({ name }: { name: 'clock' | 'hours' | 'edit' | 'export' | 'team' | 'schedule' | 'reports' | 'punch' }) {
  const common = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (name) {
    case 'clock': return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></svg>;
    case 'hours': return <svg {...common}><path d="M7 3h8l3 3v15H7z" /><path d="M15 3v4h4M10 12l2 2 4-5" /></svg>;
    case 'edit': return <svg {...common}><path d="M4 20h4l11-11-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></svg>;
    case 'export': return <svg {...common}><path d="M12 3v12" /><path d="m8 7 4-4 4 4" /><path d="M5 13v7h14v-7" /></svg>;
    case 'team': return <svg {...common}><circle cx="9" cy="8" r="3" /><circle cx="17" cy="9" r="2" /><path d="M3.5 20c.7-4 2.5-6 5.5-6s4.8 2 5.5 6M14 15c2.8 0 4.7 1.7 5.5 5" /></svg>;
    case 'schedule': return <svg {...common}><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 9h16" /></svg>;
    case 'reports': return <svg {...common}><path d="M6 20V10M12 20V4M18 20v-7" /></svg>;
    case 'punch': return <svg {...common}><circle cx="12" cy="12" r="8" /><path d="M12 6v6l4 2" /></svg>;
  }
}

export function BundyStatusBar({ time }: { time: string }) {
  return (
    <div className="bundy-status-bar" aria-hidden="true">
      <span>{time}</span>
      <span className="bundy-status-signal">●●● <small>5G</small></span>
    </div>
  );
}

export function BundyEmployeeNav() {
  return (
    <nav className="bundy-mobile-nav" aria-label="Accesos de jornada">
      <Link to="/"><Icon name="clock" /><span>Fichar</span></Link>
      <Link to="/registro"><Icon name="hours" /><span>Mis horas</span></Link>
      <Link to="/correcciones"><Icon name="edit" /><span>Correcciones</span></Link>
      <Link to="/exportar"><Icon name="export" /><span>Exportar</span></Link>
    </nav>
  );
}

export function BundyManagerNav() {
  return (
    <nav className="bundy-mobile-nav" aria-label="Accesos de gestión">
      <Link to="/gestion/empleados"><Icon name="team" /><span>Equipo</span></Link>
      <Link to="/gestion/horarios"><Icon name="schedule" /><span>Turnos</span></Link>
      <Link to="/gestion/exportaciones"><Icon name="reports" /><span>Informes</span></Link>
      <Link to="/"><Icon name="punch" /><span>Fichar</span></Link>
    </nav>
  );
}

export function BundyPhoneScreen({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`bundy-phone-screen ${className}`.trim()}>{children}</section>;
}

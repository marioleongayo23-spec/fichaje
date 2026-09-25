import type { ClockState, EventSource, Role, TimeAction } from './types';

// Presentation only: the server decides whether a transition is valid. The
// client merely avoids offering actions that the current state cannot accept.
export const ACTIONS_BY_STATE: Record<ClockState, TimeAction[]> = {
  OUT: ['CLOCK_IN'],
  WORKING: ['BREAK_START', 'CLOCK_OUT'],
  PAUSED: ['BREAK_END', 'CLOCK_OUT'],
};

export const STATE_LABEL: Record<ClockState, string> = {
  OUT: 'Fuera de jornada', WORKING: 'Trabajando', PAUSED: 'En pausa',
};
export const ACTION_LABEL: Record<TimeAction, string> = {
  CLOCK_IN: 'Entrada', BREAK_START: 'Iniciar pausa', BREAK_END: 'Finalizar pausa', CLOCK_OUT: 'Salida',
};
export const ACTION_DONE: Record<TimeAction, string> = {
  CLOCK_IN: 'Entrada registrada', BREAK_START: 'Pausa iniciada', BREAK_END: 'Pausa finalizada', CLOCK_OUT: 'Salida registrada',
};
export const EVENT_LABEL: Record<TimeAction, string> = {
  CLOCK_IN: 'Entrada', BREAK_START: 'Inicio de pausa', BREAK_END: 'Fin de pausa', CLOCK_OUT: 'Salida',
};
export const SOURCE_LABEL: Record<EventSource, string> = {
  WEB: 'Fichaje original (web)', KIOSK: 'Fichaje original (kiosco)', CORRECTION: 'Corrección aprobada',
};
export const ROLE_LABEL: Record<Role, string> = {
  OWNER: 'Propietario', ADMIN: 'Administrador', EMPLOYEE: 'Empleado',
};

export function isManager(role: Role | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

// Stable backend codes are mapped to plain Spanish. Raw SQL, stacks, hints and
// identifiers are never shown: unknown messages fall back to a generic text.
export type ErrorKind =
  | 'network' | 'timeout' | 'unauthenticated' | 'forbidden' | 'conflict' | 'validation' | 'busy' | 'server';

export class ApiError extends Error {
  constructor(readonly kind: ErrorKind, readonly code: string, readonly status = 0) {
    super(code);
    this.name = 'ApiError';
  }
}

const CONFLICTS = new Set(['VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'ALREADY_DECIDED']);
const VALIDATION = new Set([
  'INVALID_INPUT', 'INVALID_TRANSITION', 'POLICY_REQUIRED', 'CLOCK_REGRESSION', 'INVALID_TIMEZONE',
  'INVALID_TIMELINE', 'INVALID_ORDINAL', 'FUTURE_TIME', 'POLICY_BACKDATE', 'HOURS_MISMATCH',
  'INCOMPLETE_PERIOD', 'LAST_OWNER', 'EMAIL_NOT_VERIFIED',
]);

interface ErrorBody { message?: unknown; code?: unknown; error?: unknown }

export function toApiError(status: number, body: unknown): ApiError {
  const payload = (body && typeof body === 'object' ? body : {}) as ErrorBody;
  const message = typeof payload.message === 'string' ? payload.message
    : typeof payload.error === 'string' ? payload.error : '';
  const sqlstate = typeof payload.code === 'string' ? payload.code : '';
  if (status === 0) {
    return /^(TimeoutError|AbortError)\b/.test(message)
      ? new ApiError('timeout', 'TIMEOUT', 0) : new ApiError('network', 'NETWORK', 0);
  }
  if (CONFLICTS.has(message)) return new ApiError('conflict', message, status);
  if (VALIDATION.has(message)) return new ApiError('validation', message, status);
  if (message === 'RETRYABLE_TIMEOUT' || sqlstate === '55P03' || sqlstate === '57014') {
    return new ApiError('busy', 'BUSY', status);
  }
  if (status === 401 || message === 'UNAUTHENTICATED' || sqlstate === 'PGRST301' || sqlstate === 'PGRST303') {
    return new ApiError('unauthenticated', 'UNAUTHENTICATED', status);
  }
  if (status === 403 || message === 'FORBIDDEN' || message === 'AUTH_FAILED' || sqlstate === '42501') {
    return new ApiError('forbidden', 'FORBIDDEN', status);
  }
  if (status === 400 || status === 404 || status === 409 || status === 422) {
    return new ApiError('validation', 'INVALID_INPUT', status);
  }
  return new ApiError('server', 'SERVER', status);
}

export function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new ApiError('timeout', 'TIMEOUT');
  }
  if (error instanceof TypeError) return new ApiError('network', 'NETWORK');
  return new ApiError('server', 'SERVER');
}

const MESSAGES: Record<string, string> = {
  NETWORK: 'No hay conexión con el servicio. Comprueba tu conexión e inténtalo de nuevo.',
  TIMEOUT: 'El servicio no ha respondido a tiempo.',
  UNAUTHENTICATED: 'Tu sesión ha caducado. Vuelve a iniciar sesión.',
  FORBIDDEN: 'No tienes permiso para esta acción o tu acceso ha cambiado.',
  BUSY: 'El servicio está ocupado y no ha guardado nada. Inténtalo de nuevo en unos segundos.',
  SERVER: 'Se ha producido un error en el servicio. Inténtalo de nuevo más tarde.',
  VERSION_CONFLICT: 'Los datos han cambiado mientras trabajabas. Se han actualizado; revísalos y vuelve a intentarlo.',
  IDEMPOTENCY_CONFLICT: 'Esta operación ya se envió con otros datos. Vuelve a empezarla.',
  ALREADY_DECIDED: 'Otra persona ya ha decidido esta solicitud.',
  INVALID_INPUT: 'Revisa los datos introducidos.',
  INVALID_TRANSITION: 'Esa acción no es posible con el estado actual.',
  POLICY_REQUIRED: 'No hay un horario asignado. La empresa debe asignarlo antes de fichar.',
  CLOCK_REGRESSION: 'El servicio no ha podido garantizar la hora y no ha registrado nada. Inténtalo más tarde o avisa a la empresa.',
  INVALID_TIMEZONE: 'La zona horaria no coincide con la de la jornada o del horario aplicable.',
  INVALID_TIMELINE: 'La propuesta dejaría la jornada en un orden imposible, por ejemplo una salida antes de la entrada o dos jornadas solapadas.',
  INVALID_ORDINAL: 'Dos fichajes quedarían exactamente a la misma hora. Ajusta la hora.',
  FUTURE_TIME: 'No se pueden indicar horas futuras.',
  POLICY_BACKDATE: 'La fecha de inicio no puede ser anterior a ahora.',
  HOURS_MISMATCH: 'La suma no coincide con el tiempo computable del mes calculado por el servicio.',
  INCOMPLETE_PERIOD: 'El mes tiene jornadas abiertas. Deben resolverse antes de clasificar las horas.',
  LAST_OWNER: 'La organización debe conservar al menos una persona propietaria activa.',
  EMAIL_NOT_VERIFIED: 'Confirma tu correo electrónico antes de crear una empresa.',
};

export function errorMessage(error: unknown): string {
  const apiError = asApiError(error);
  return MESSAGES[apiError.code] ?? MESSAGES.SERVER;
}

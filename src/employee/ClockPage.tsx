import { useCallback, useEffect, useRef, useState } from 'react';
import { useNow, usePolicies } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { ACTION_DONE, ACTION_LABEL, ACTIONS_BY_STATE, STATE_LABEL } from '../domain/labels';
import type { ClockReceipt, EmployeeState, TimeAction } from '../domain/types';
import { newRequestId, rpc } from '../lib/api';
import { asApiError, errorMessage } from '../lib/errors';
import { useOnline } from '../lib/online';
import { DEFAULT_ZONE, formatDate, formatDateTime, formatTime, localDate, zoneAbbreviation } from '../lib/time';
import { LiveRegion, Loading, Notice, PageHeader } from '../ui/components';
import { BundyEmployeeNav, BundyPhoneScreen, BundyStatusBar } from '../ui/BundyMobile';

type Phase =
  | { kind: 'loading' }
  | { kind: 'load-error'; message: string }
  | { kind: 'ready' }
  | { kind: 'sending'; action: TimeAction }
  | { kind: 'unknown'; action: TimeAction; requestId: string; expectedVersion: number };

interface Confirmation { action: TimeAction; receipt: ClockReceipt }

// Outcome after a request left the browser but no reliable answer came back.
function isUnknownOutcome(error: unknown): boolean {
  const apiError = asApiError(error);
  return apiError.kind === 'network' || apiError.kind === 'timeout' || (apiError.kind === 'server' && (apiError.status === 0 || apiError.status >= 500));
}

export function ClockPage() {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const employee = tenant.current.employee;
  const org = tenant.current.organization.id;
  const online = useOnline();
  const now = useNow();
  const policy = usePolicies(employee?.id ?? null);
  const zone = policy.data?.current?.timezone ?? DEFAULT_ZONE;
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [state, setState] = useState<EmployeeState | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const inFlight = useRef(false);
  const wasOnline = useRef(online);
  const receiptHeading = useRef<HTMLHeadingElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);

  const loadState = useCallback(async (quiet = false) => {
    if (!employee) return;
    if (!quiet) setPhase({ kind: 'loading' });
    try {
      const next = await rpc<EmployeeState>(client, 'get_employee_state', { p_organization_id: org, p_employee_id: employee.id });
      setState(next);
      setPhase({ kind: 'ready' });
    } catch (failure) {
      tenant.handleError(failure);
      setState(null);
      setPhase({ kind: 'load-error', message: errorMessage(failure) });
    }
  }, [client, org, employee, tenant.handleError]);

  useEffect(() => { void loadState(); }, [loadState]);
  // Keyboard/screen reader users land on the outcome instead of a removed button.
  useEffect(() => { if (confirmation) receiptHeading.current?.focus(); }, [confirmation]);
  useEffect(() => { if (phase.kind === 'unknown') retryButton.current?.focus(); }, [phase.kind]);

  // Back online: the server state is fetched before any action is offered.
  // Earlier clicks are never replayed.
  useEffect(() => {
    if (online && !wasOnline.current) {
      setStatus('Conexión restablecida. Estado actualizado desde el servidor.');
      setError(null);
      void loadState();
    }
    wasOnline.current = online;
  }, [online, loadState]);

  const attempt = async (action: TimeAction, requestId: string, expectedVersion: number) => {
    if (!employee) return;
    inFlight.current = true;
    setPhase({ kind: 'sending', action });
    setStatus(`Enviando ${ACTION_LABEL[action].toLowerCase()}… Espera la confirmación del servidor.`);
    try {
      const receipt = await rpc<ClockReceipt>(client, 'record_time_event', {
        p_organization_id: org, p_request_id: requestId, p_employee_id: employee.id, p_action: action, p_expected_version: expectedVersion,
      });
      setState({ state: receipt.state, version: receipt.version, last_sequence: receipt.sequence, last_event_at: receipt.server_at,
        open_session_id: receipt.state === 'OUT' ? null : receipt.session_id, incident: receipt.state === 'OUT' ? null : 'OPEN_SESSION' });
      setConfirmation({ action, receipt });
      setStatus(null);
      setPhase({ kind: 'ready' });
    } catch (failure) {
      setStatus(null);
      if (isUnknownOutcome(failure)) {
        setPhase({ kind: 'unknown', action, requestId, expectedVersion });
      } else {
        tenant.handleError(failure);
        setError(errorMessage(failure));
        await loadState(true);
      }
    } finally {
      inFlight.current = false;
    }
  };

  const send = (action: TimeAction) => {
    if (inFlight.current || !state) return;
    setConfirmation(null);
    setError(null);
    if (!navigator.onLine) {
      setError('Sin conexión: no se ha enviado nada. Sigue el procedimiento de contingencia de tu empresa y solicita después una corrección.');
      return;
    }
    void attempt(action, newRequestId(), state.version);
  };

  const retry = () => {
    if (phase.kind !== 'unknown' || inFlight.current) return;
    if (!navigator.onLine) {
      setError('Sigues sin conexión. El resultado continúa pendiente; vuelve a comprobarlo cuando haya conexión.');
      return;
    }
    setError(null);
    void attempt(phase.action, phase.requestId, phase.expectedVersion);
  };

  if (!employee) {
    return (
      <>
        <PageHeader title="Fichar" />
        <Notice tone="info" title="Tu cuenta no tiene ficha de empleado en esta organización.">
          <p>Solo se ficha con una ficha de empleado propia. Pide a tu empresa que la vincule si debes registrar tu jornada.</p>
        </Notice>
      </>
    );
  }

  const busy = phase.kind === 'sending' || phase.kind === 'loading';
  const actions = state ? ACTIONS_BY_STATE[state.state] : [];
  const openSince = state?.state !== 'OUT' && state?.last_event_at && localDate(state.last_event_at, zone) !== localDate(now, zone);
  const initials = employee.display_name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('');
  const firstUse = state?.state === 'OUT' && state.version === 0 && !state.last_event_at;
  const primaryAction = actions[0] ?? null;
  const secondaryActions = actions.slice(1);
  const currentPolicy = policy.data?.current;

  if (firstUse && state && (phase.kind === 'ready' || phase.kind === 'sending')) {
    return (
      <BundyPhoneScreen className="bundy-welcome-screen">
        <div className="bundy-screen-content">
          <BundyStatusBar time={formatTime(now, zone)} />
          <div className="bundy-progress-dots" aria-hidden="true"><span className="active" /><span /><span /></div>
          <PageHeader title="Fichar">
            <div className="bundy-welcome-icon"><img src="/bundy-app-icon.svg" alt="" aria-hidden="true" /></div>
            <p className="bundy-welcome-title">Hola, {employee.display_name.split(/\s+/)[0]}. Yo<br />apunto tus horas.</p>
            <p className="bundy-welcome-copy">Tú las ves siempre que quieras. Si algo no cuadra, lo corriges y tu responsable lo valida.</p>
            <div className="bundy-welcome-note">
              <span className="bundy-note-icon" aria-hidden="true">✓</span>
              <span>Tu fichaje usa la hora segura del servidor. No usamos ubicación, fotos ni biometría.</span>
            </div>
          </PageHeader>
          <p className="state-value visually-hidden">{STATE_LABEL[state.state]}</p>
          <LiveRegion tone="info" message={status} />
          <LiveRegion tone="error" message={error} />
          <div className="bundy-welcome-spacer" />
          <button type="button" className="btn bundy-first-bundy" aria-label="Entrada" aria-disabled={busy}
            onClick={() => send('CLOCK_IN')}>
            {phase.kind === 'sending' ? 'Enviando…' : 'Hacer mi primer bundy'}
          </button>
        </div>
      </BundyPhoneScreen>
    );
  }

  return (
    <BundyPhoneScreen className="bundy-clock-screen clock-page">
      <div className="bundy-screen-content">
        <BundyStatusBar time={formatTime(now, zone)} />

        <PageHeader title="Fichar">
          <div className="bundy-greeting-row">
            <div className="bundy-greeting">
              <span>Buenos días,</span>
              <strong>{employee.display_name}</strong>
            </div>
            <span className="bundy-avatar" aria-hidden="true">{initials}</span>
          </div>

          <div className="bundy-shift-card">
            <span className="bundy-shift-icon" aria-hidden="true">□</span>
            <span>
              <strong>Tu horario hoy</strong>
              <small>{currentPolicy
                ? `Horario v${currentPolicy.version} · ${zoneAbbreviation(now, zone)} · pausas ${currentPolicy.break_counts_as_work ? 'computables' : 'no computables'}`
                : 'Sin horario asignado'}</small>
            </span>
          </div>

          <div className="bundy-company-card">
            <span aria-hidden="true" className="bundy-company-pin">⌾</span>
            <span>{tenant.current.organization.name}</span>
          </div>
        </PageHeader>

        <p className="visually-hidden">La hora mostrada es informativa. La hora del fichaje la fija el servidor.</p>
        <LiveRegion tone="info" message={status} />
        <LiveRegion tone="error" message={error} />

        {phase.kind === 'loading' && <Loading label="Consultando tu estado en el servidor…" />}
        {phase.kind === 'load-error' && (
          <Notice tone="error" title="No se ha podido consultar tu estado actual.">
            <p>{phase.message} Sin conocer tu estado no se puede fichar.</p>
            <button type="button" className="btn btn-secondary" onClick={() => void loadState()} disabled={!online}>Reintentar</button>
          </Notice>
        )}

        {openSince && (
          <Notice tone="warning" title="Tu jornada sigue abierta desde otro día.">
            <p>Si olvidaste fichar la salida, fíchala ahora y solicita una corrección de la hora en «Mis correcciones».</p>
          </Notice>
        )}

        {phase.kind === 'unknown' && (
          <div role="alert" className="unknown-outcome">
            <Notice tone="warning" title={`Resultado desconocido: no sabemos si se ha registrado la ${ACTION_LABEL[phase.action].toLowerCase()}.`}>
              <p>La conexión se interrumpió después de enviar. No des el fichaje por hecho.</p>
              <p>«Comprobar resultado» reenvía exactamente la misma solicitud: si ya se registró verás ese mismo fichaje; si no, se registrará una sola vez con la hora del servidor.</p>
              <div className="button-row">
                <button ref={retryButton} type="button" className="btn btn-primary" onClick={retry}>Comprobar resultado</button>
                <button type="button" className="btn btn-secondary" onClick={() => void loadState()}>Consultar solo mi estado</button>
              </div>
            </Notice>
          </div>
        )}

        {confirmation && (
          <section className="receipt bundy-receipt" aria-labelledby="receipt-title">
            <h2 id="receipt-title" ref={receiptHeading} tabIndex={-1}>{ACTION_DONE[confirmation.action]}</h2>
            <dl>
              <div><dt>Hora registrada por el servidor</dt>
                <dd>{formatTime(confirmation.receipt.server_at, zone, true)} ({zoneAbbreviation(confirmation.receipt.server_at, zone)}), {formatDate(confirmation.receipt.server_at, zone)}</dd></div>
              <div><dt>Estado resultante</dt><dd>{STATE_LABEL[confirmation.receipt.state]}</dd></div>
            </dl>
          </section>
        )}

        {state && (phase.kind === 'ready' || phase.kind === 'sending') && (
          <>
            <section aria-labelledby="actions-title" className="bundy-clock-action-zone">
              <h2 id="actions-title" className="visually-hidden">Acciones disponibles</h2>
              {!online ? (
                <Notice tone="warning" title="Sin conexión: no se puede fichar.">
                  <p>No se guarda ningún fichaje para enviarlo más tarde. Sigue el procedimiento de contingencia de tu empresa y, cuando vuelva la conexión, solicita una corrección.</p>
                </Notice>
              ) : primaryAction ? (
                <>
                  <button type="button" className={`btn btn-clock btn-clock-${primaryAction.toLowerCase()} bundy-main-clock-action bundy-action-${primaryAction.toLowerCase()}`}
                    aria-label={ACTION_LABEL[primaryAction]} aria-disabled={busy} onClick={() => send(primaryAction)}>
                    {phase.kind === 'sending' && phase.action === primaryAction ? <span className="clock-cta-title">Enviando…</span> : (
                      <>
                        <img src="/bundy-symbol.svg" alt="" aria-hidden="true" />
                        <span className="clock-cta-title">{primaryAction === 'CLOCK_IN' ? 'Hacer bundy' : ACTION_LABEL[primaryAction]}</span>
                        <span className="clock-cta-subtitle">{primaryAction === 'CLOCK_IN' ? 'Entrada' : STATE_LABEL[state.state]}</span>
                      </>
                    )}
                  </button>
                  {secondaryActions.length > 0 && (
                    <div className="bundy-secondary-actions">
                      {secondaryActions.map((action) => (
                        <button key={action} type="button" className="btn btn-secondary"
                          aria-label={ACTION_LABEL[action]} aria-disabled={busy} onClick={() => send(action)}>
                          {phase.kind === 'sending' && phase.action === action ? 'Enviando…' : ACTION_LABEL[action]}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </section>

            <section className="bundy-clock-readout" aria-labelledby="state-title">
              <h2 id="state-title" className="visually-hidden">Estado actual</h2>
              <p className="state-value visually-hidden">{STATE_LABEL[state.state]}</p>
              <p className="bundy-clock-digits">
                {state.state === 'OUT' ? '00:00:00' : state.last_event_at ? formatTime(state.last_event_at, zone, true) : '—'}
              </p>
              <p className="bundy-clock-state">
                {state.state === 'OUT' ? 'Aún no has fichado hoy' : STATE_LABEL[state.state]}
              </p>
              {state.last_event_at && state.state !== 'OUT' && (
                <p className="bundy-clock-meta">Última acción confirmada a las {formatTime(state.last_event_at, zone, true)} · hora del servidor</p>
              )}
            </section>
          </>
        )}

        {state?.state === 'OUT' && policy.data && !policy.data.current && (
          <p className="hint">No tienes un horario asignado ahora mismo; el servidor rechazará la entrada hasta que tu empresa lo asigne.</p>
        )}
      </div>
      <BundyEmployeeNav />
    </BundyPhoneScreen>
  );
}

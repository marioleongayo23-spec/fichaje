import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ACTION_DONE, ACTION_LABEL, STATE_LABEL } from '../domain/labels';
import type { ClockReceipt, TimeAction } from '../domain/types';
import { asApiError } from '../lib/errors';
import { formatTime } from '../lib/time';
import type { Identification, KioskGateway } from './gateway';

// Strictly below the 15 s limit, leaving margin for rendering on slow devices.
export const CLEAR_AFTER_MS = 14_000;
export const RECEIPT_MS = 10_000;

type Step =
  | { kind: 'code' }
  | { kind: 'pin' }
  | { kind: 'identifying' }
  | { kind: 'choose'; identity: Identification }
  | { kind: 'sending'; identity: Identification; action: TimeAction }
  | { kind: 'done'; action: TimeAction; receipt: ClockReceipt }
  | { kind: 'unknown'; identity: Identification; action: TimeAction };

const UNCONFIRMED = 'No se ha podido confirmar el fichaje. Vuelve a identificarte: verás tu estado actual antes de fichar de nuevo.';

const GENERIC = 'No se ha podido identificar. Comprueba el código y el PIN o avisa a tu empresa.';
const deviceZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Madrid';

// Shared-device flow. Code and PIN live only in the input elements and in the
// single request that uses them; they are cleared immediately after sending,
// never stored, logged or placed in URLs. Everything visible about a person is
// cleared less than 15 s after the last interaction.
export function KioskTerminal({ gateway, online }: { gateway: KioskGateway; online: boolean }) {
  const [step, setStep] = useState<Step>({ kind: 'code' });
  const [message, setMessage] = useState<string | null>(null);
  const [activity, setActivity] = useState(0);
  const code = useRef<HTMLInputElement>(null);
  const pin = useRef<HTMLInputElement>(null);
  const pendingCode = useRef('');
  const heading = useRef<HTMLHeadingElement>(null);

  const reset = useCallback((notice: string | null = null) => {
    pendingCode.current = '';
    if (code.current) code.current.value = '';
    if (pin.current) pin.current.value = '';
    setMessage(notice);
    setActivity(0);
    setStep({ kind: 'code' });
  }, []);

  // Inactivity limit: nothing personal stays on screen for 15 s or more.
  useEffect(() => {
    if (step.kind === 'code' && !message && activity === 0) return;
    if (step.kind === 'identifying' || step.kind === 'sending') return;
    const timer = window.setTimeout(() => reset(), step.kind === 'done' ? RECEIPT_MS : CLEAR_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [step, message, activity, reset]);

  useEffect(() => {
    if (step.kind === 'code') code.current?.focus();
    else if (step.kind === 'pin') pin.current?.focus();
    else heading.current?.focus();
  }, [step.kind]);

  const touch = () => setActivity((n) => n + 1);

  const submitCode = (event: FormEvent) => {
    event.preventDefault();
    const value = code.current?.value.trim() ?? '';
    if (!value || value.length > 64) { setMessage('Escribe tu código de empleado.'); return; }
    pendingCode.current = value;
    code.current!.value = '';
    setMessage(null);
    setStep({ kind: 'pin' });
  };

  const submitPin = async (event: FormEvent) => {
    event.preventDefault();
    const secret = pin.current?.value ?? '';
    if (pin.current) pin.current.value = '';
    if (!/^\d{8,32}$/.test(secret)) { setMessage('El PIN tiene al menos 8 cifras.'); return; }
    if (!online) { reset('Sin conexión: no se puede fichar. Sigue el procedimiento de contingencia de tu empresa.'); return; }
    const value = pendingCode.current;
    pendingCode.current = '';
    setMessage(null);
    setStep({ kind: 'identifying' });
    try {
      setStep({ kind: 'choose', identity: await gateway.identify(value, secret) });
    } catch {
      reset(GENERIC);
    }
  };

  // `retry` re-sends the identical tuple after an unknown outcome: the server
  // returns the committed receipt or records it once; never a second event.
  const send = async (identity: Identification, action: TimeAction, retry = false) => {
    const challenge = identity.challenges[action];
    if (!challenge) { reset('Esa acción no está disponible. Vuelve a identificarte.'); return; }
    setStep({ kind: 'sending', identity, action });
    try {
      const receipt = await gateway.record(identity.version, challenge);
      setStep({ kind: 'done', action, receipt });
    } catch (failure) {
      const error = asApiError(failure);
      if (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'server' && error.status >= 500)) {
        setStep({ kind: 'unknown', identity, action });
      } else if (retry) {
        // The first attempt may have committed: never claim that nothing was recorded.
        reset(UNCONFIRMED);
      } else if (error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_TRANSITION') {
        reset('Tu estado ha cambiado desde otro dispositivo. No se ha registrado nada; vuelve a identificarte.');
      } else if (error.code === 'POLICY_REQUIRED') {
        reset('No tienes un horario asignado. Avisa a tu empresa.');
      } else {
        reset('No se ha registrado el fichaje. El tiempo para elegir puede haber caducado; vuelve a identificarte.');
      }
    }
  };

  const zone = deviceZone();
  return (
    <div className="kiosk-terminal" onKeyDown={touch} onPointerDown={touch}>
      <div role="alert" className="live-region">{message && <p className="kiosk-message">{message}</p>}</div>
      {step.kind === 'code' && (
        <form noValidate onSubmit={submitCode} className="kiosk-form" autoComplete="off">
          <h2 tabIndex={-1} ref={heading}>Identifícate para fichar</h2>
          <label htmlFor="kiosk-code">Código de empleado</label>
          <input ref={code} id="kiosk-code" name="kiosk-code" type="text" autoComplete="off" autoCorrect="off" autoCapitalize="none"
            spellCheck={false} maxLength={64} onInput={touch} />
          <button type="submit" className="btn btn-primary btn-kiosk">Continuar</button>
        </form>
      )}
      {step.kind === 'pin' && (
        <form noValidate onSubmit={(e) => void submitPin(e)} className="kiosk-form" autoComplete="off">
          <h2 tabIndex={-1} ref={heading}>Introduce tu PIN</h2>
          <label htmlFor="kiosk-pin">PIN (8 cifras)</label>
          <input ref={pin} id="kiosk-pin" name="kiosk-pin" type="password" inputMode="numeric" autoComplete="off"
            maxLength={32} onInput={touch} />
          <div className="button-row">
            <button type="submit" className="btn btn-primary btn-kiosk">Continuar</button>
            <button type="button" className="btn btn-secondary btn-kiosk" onClick={() => reset()}>Cancelar</button>
          </div>
        </form>
      )}
      {step.kind === 'identifying' && <p role="status" className="kiosk-status">Comprobando…</p>}
      {(step.kind === 'choose' || step.kind === 'sending') && (
        <section aria-labelledby="kiosk-choose" className="kiosk-form">
          <h2 id="kiosk-choose" tabIndex={-1} ref={heading}>Estado: {STATE_LABEL[step.identity.state]}</h2>
          <p>Elige qué quieres registrar.</p>
          <div className="clock-actions">
            {step.identity.actions.filter((a) => step.identity.challenges[a]).map((action) => (
              <button key={action} type="button" className={`btn btn-clock btn-clock-${action.toLowerCase()}`}
                aria-disabled={step.kind === 'sending'} onClick={() => step.kind === 'choose' && void send(step.identity, action)}>
                {step.kind === 'sending' && step.action === action ? 'Enviando…' : ACTION_LABEL[action]}
              </button>
            ))}
          </div>
          {/* While sending, the outcome must be shown: cancelling is not offered. */}
          <button type="button" className="btn btn-secondary btn-kiosk" aria-disabled={step.kind === 'sending'}
            onClick={() => step.kind === 'choose' && reset()}>Cancelar</button>
        </section>
      )}
      {step.kind === 'done' && (
        <section aria-labelledby="kiosk-done" className="kiosk-form receipt">
          <h2 id="kiosk-done" tabIndex={-1} ref={heading}>{ACTION_DONE[step.action]}</h2>
          <p>Hora del servidor: <strong>{formatTime(step.receipt.server_at, zone, true)}</strong></p>
          <p>Estado: <strong>{STATE_LABEL[step.receipt.state]}</strong></p>
          <p className="hint">Esta pantalla se limpiará automáticamente en unos segundos.</p>
          <button type="button" className="btn btn-primary btn-kiosk" onClick={() => reset()}>Terminar</button>
        </section>
      )}
      {step.kind === 'unknown' && (
        <section aria-labelledby="kiosk-unknown" className="kiosk-form">
          <h2 id="kiosk-unknown" tabIndex={-1} ref={heading}>Resultado desconocido</h2>
          <p>No sabemos si se ha registrado. «Comprobar» reenvía la misma solicitud: no se duplicará.</p>
          <div className="button-row">
            <button type="button" className="btn btn-primary btn-kiosk" onClick={() => void send(step.identity, step.action, true)}>Comprobar</button>
            <button type="button" className="btn btn-secondary btn-kiosk" onClick={() => reset()}>Salir</button>
          </div>
        </section>
      )}
    </div>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { addOperation, describeOperation, nextOrdinal, reasonError, REASON_MAX, replaceOperation, voidOperation } from '../domain/corrections';
import { sortEvents } from '../domain/durations';
import type { EvidenceSession } from '../domain/evidence';
import { EVENT_LABEL } from '../domain/labels';
import type { CorrectionOperation, EmployeeState, TimeAction, TimelineItem } from '../domain/types';
import { newRequestId, rpc } from '../lib/api';
import { asApiError, errorMessage } from '../lib/errors';
import { formatTime, localDate, zoneAbbreviation, zonedCandidates } from '../lib/time';
import { Dialog, Field, LiveRegion } from '../ui/components';

type Mode = 'REPLACE' | 'VOID' | 'ADD' | 'NEW_DAY';
const ADDABLE: TimeAction[] = ['CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'];
const CONTINGENCY = '[Contingencia] ';

function itemKey(item: TimelineItem): string {
  return item.adjustment_id ?? item.event_id ?? `${item.effective_at}-${item.ordinal}`;
}

// A local date+time in the session zone must map to exactly one instant.
function TimeInput({ label, date, time, zone, choice, onDate, onTime, onChoice, error }: {
  label: string; date: string; time: string; zone: string; choice: number; error?: string | null;
  onDate: (v: string) => void; onTime: (v: string) => void; onChoice: (v: number) => void;
}) {
  const candidates = date && time ? zonedCandidates(date, time, zone) : [];
  return (
    <fieldset className="fieldset">
      <legend>{label}</legend>
      <div className="inline-fields">
        <Field label="Fecha">{(p) => <input {...p} type="date" value={date} onChange={(e) => onDate(e.target.value)} required />}</Field>
        <Field label="Hora" error={error}>{(p) => <input {...p} type="time" value={time} onChange={(e) => onTime(e.target.value)} required />}</Field>
      </div>
      {candidates.length === 2 && (
        <fieldset className="fieldset">
          <legend>Esa hora se repite ese día por el cambio de hora. ¿Cuál es?</legend>
          {candidates.map((candidate, index) => (
            <label key={candidate.toISOString()} className="radio">
              <input type="radio" name={`${label}-dst`} checked={choice === index} onChange={() => onChoice(index)} />
              {index === 0 ? 'Primera vez' : 'Segunda vez'} ({zoneAbbreviation(candidate, zone)})
            </label>
          ))}
        </fieldset>
      )}
    </fieldset>
  );
}

function resolve(date: string, time: string, zone: string, choice: number): Date | string {
  const candidates = zonedCandidates(date, time, zone);
  if (!date || !time) return 'Indica fecha y hora.';
  if (candidates.length === 0) return 'Esa hora no existe ese día por el cambio de hora.';
  const instant = candidates[Math.min(choice, candidates.length - 1)];
  if (instant.getTime() > Date.now()) return 'No se pueden indicar horas futuras.';
  return instant;
}

export function CorrectionDialog({ open, onClose, onSubmitted, employeeId, session, knownItems, newSessionZone }: {
  open: boolean; onClose: () => void; onSubmitted: (message: string) => void; employeeId: string;
  session: EvidenceSession | null; knownItems: TimelineItem[]; newSessionZone: string;
}) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const items = session ? sortEvents(session.effective) : [];
  const zone = session?.timezone ?? newSessionZone;
  const firstDate = items[0] ? localDate(items[0].effective_at, zone) : '';
  const [mode, setMode] = useState<Mode>(session ? 'REPLACE' : 'NEW_DAY');
  const [target, setTarget] = useState('');
  const [eventType, setEventType] = useState<TimeAction>('CLOCK_OUT');
  const [times, setTimes] = useState({ date: firstDate, time: '', choice: 0, exitDate: firstDate, exitTime: '', exitChoice: 0 });
  const [pause, setPause] = useState({ enabled: false, startTime: '', endTime: '' });
  const [reason, setReason] = useState('');
  const [contingency, setContingency] = useState(false);
  const [step, setStep] = useState<'edit' | 'review'>('edit');
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [operations, setOperations] = useState<CorrectionOperation[]>([]);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const newSessionId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    let active = true;
    rpc<EmployeeState>(client, 'get_employee_state', { p_organization_id: org, p_employee_id: employeeId })
      .then((state) => { if (active) setBaseVersion(state.version); })
      .catch((failure) => { if (active) { tenant.handleError(failure); setError(errorMessage(failure)); } });
    return () => { active = false; };
  }, [open, client, org, employeeId, tenant.handleError]);

  const build = (): CorrectionOperation[] | null => {
    const found: Record<string, string | null> = {};
    const ops: CorrectionOperation[] = [];
    const selected = items.find((item) => itemKey(item) === target);
    if ((mode === 'REPLACE' || mode === 'VOID') && !selected) found.target = 'Elige el fichaje que quieres corregir.';
    if (mode === 'REPLACE' || mode === 'ADD' || mode === 'NEW_DAY') {
      const at = resolve(times.date, times.time, zone, times.choice);
      if (typeof at === 'string') found.time = at;
      else if (mode === 'REPLACE' && selected) ops.push(replaceOperation(selected, at, zone));
      else if (mode === 'ADD' && session) ops.push(addOperation(session.id, eventType, at, zone, nextOrdinal(knownItems)));
      else if (mode === 'NEW_DAY') {
        const exit = resolve(times.exitDate, times.exitTime, zone, times.exitChoice);
        if (typeof exit === 'string') found.exit = exit;
        else if (exit.getTime() < at.getTime()) found.exit = 'La salida no puede ser anterior a la entrada.';
        else {
          const sessionId = newSessionId.current;
          const list: [TimeAction, Date][] = [['CLOCK_IN', at]];
          if (pause.enabled) {
            const start = resolve(times.date, pause.startTime, zone, 0);
            const end = resolve(times.date, pause.endTime, zone, 0);
            if (typeof start === 'string' || typeof end === 'string') found.pause = 'Indica inicio y fin de la pausa (mismo día de la entrada).';
            else if (start.getTime() < at.getTime() || end.getTime() < start.getTime() || exit.getTime() < end.getTime()) found.pause = 'La pausa debe quedar entre la entrada y la salida.';
            else list.push(['BREAK_START', start], ['BREAK_END', end]);
          }
          list.push(['CLOCK_OUT', exit]);
          list.forEach(([type, when], index) => ops.push(addOperation(sessionId, type, when, zone, nextOrdinal(knownItems, index))));
        }
      }
    }
    if (mode === 'VOID' && selected) ops.push(voidOperation(selected));
    found.reason = reasonError(reason);
    setErrors(found);
    return Object.values(found).some(Boolean) ? null : ops;
  };

  const review = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const ops = build();
    if (!ops) { setError('Revisa los campos marcados.'); return; }
    setOperations(ops);
    setStep('review');
  };

  const submit = async () => {
    if (baseVersion === null || pending) return;
    const fullReason = (contingency ? CONTINGENCY : '') + reason.trim();
    const key = JSON.stringify([baseVersion, fullReason, operations]);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'submit_correction', {
        p_organization_id: org, p_request_id: attempt.current.requestId, p_employee_id: employeeId,
        p_base_version: baseVersion, p_reason: fullReason, p_operations: operations,
      });
      attempt.current = null;
      onSubmitted('Solicitud de corrección enviada. Queda pendiente hasta que decida un gestor distinto de ti. Tus fichajes originales no cambian.');
    } catch (failure) {
      const apiError = asApiError(failure);
      tenant.handleError(failure);
      if (apiError.kind === 'network' || apiError.kind === 'timeout') {
        setError('No sabemos si la solicitud llegó. Pulsa «Enviar solicitud» de nuevo: se reenvía la misma y no se duplicará.');
      } else if (apiError.code === 'VERSION_CONFLICT') {
        setError('Tu registro ha cambiado mientras preparabas la solicitud. Cierra, revisa los datos actualizados y vuelve a prepararla.');
      } else {
        setError(errorMessage(failure));
      }
    } finally {
      setPending(false);
    }
  };

  const reasonLength = reason.trim().length;
  return (
    <Dialog open={open} title={session ? 'Solicitar corrección de la jornada' : 'Añadir una jornada que falta'} onClose={onClose}>
      {step === 'edit' ? (
        <form noValidate onSubmit={review}>
          <p className="hint">Tus fichajes originales nunca se modifican. La corrección se aplica solo si la aprueba un gestor distinto de ti.</p>
          {session && (
            <fieldset className="fieldset">
              <legend>¿Qué quieres corregir?</legend>
              {([['REPLACE', 'La hora de un fichaje es incorrecta'], ['VOID', 'Sobra un fichaje'], ['ADD', 'Falta un fichaje en esta jornada']] as const).map(([value, text]) => (
                <label key={value} className="radio">
                  <input type="radio" name="mode" value={value} checked={mode === value} onChange={() => setMode(value)} /> {text}
                </label>
              ))}
            </fieldset>
          )}
          {(mode === 'REPLACE' || mode === 'VOID') && (
            <fieldset className="fieldset">
              <legend>Fichaje afectado</legend>
              {items.map((item) => (
                <label key={itemKey(item)} className="radio">
                  <input type="radio" name="target" value={itemKey(item)} checked={target === itemKey(item)} onChange={() => setTarget(itemKey(item))} />
                  {EVENT_LABEL[item.event_type]} a las {formatTime(item.effective_at, zone, true)}
                </label>
              ))}
              {errors.target && <p className="field-error"><span className="notice-tag">Error:</span> {errors.target}</p>}
            </fieldset>
          )}
          {mode === 'ADD' && (
            <Field label="Tipo de fichaje que falta">
              {(p) => (
                <select {...p} value={eventType} onChange={(e) => setEventType(e.target.value as TimeAction)}>
                  {ADDABLE.map((type) => <option key={type} value={type}>{EVENT_LABEL[type]}</option>)}
                </select>
              )}
            </Field>
          )}
          {mode !== 'VOID' && (
            <TimeInput label={mode === 'NEW_DAY' ? 'Entrada' : mode === 'REPLACE' ? 'Hora correcta' : 'Hora del fichaje que falta'}
              date={times.date} time={times.time} zone={zone} choice={times.choice} error={errors.time}
              onDate={(date) => setTimes({ ...times, date, exitDate: times.exitDate || date })} onTime={(time) => setTimes({ ...times, time })}
              onChoice={(choice) => setTimes({ ...times, choice })} />
          )}
          {mode === 'NEW_DAY' && (
            <>
              <label className="checkbox">
                <input type="checkbox" checked={pause.enabled} onChange={(e) => setPause({ ...pause, enabled: e.target.checked })} /> Hubo una pausa
              </label>
              {pause.enabled && (
                <div className="inline-fields">
                  <Field label="Inicio de pausa" error={errors.pause}>{(p) => <input {...p} type="time" value={pause.startTime} onChange={(e) => setPause({ ...pause, startTime: e.target.value })} />}</Field>
                  <Field label="Fin de pausa">{(p) => <input {...p} type="time" value={pause.endTime} onChange={(e) => setPause({ ...pause, endTime: e.target.value })} />}</Field>
                </div>
              )}
              <TimeInput label="Salida" date={times.exitDate} time={times.exitTime} zone={zone} choice={times.exitChoice} error={errors.exit}
                onDate={(exitDate) => setTimes({ ...times, exitDate })} onTime={(exitTime) => setTimes({ ...times, exitTime })}
                onChoice={(exitChoice) => setTimes({ ...times, exitChoice })} />
            </>
          )}
          <Field label="Motivo (obligatorio)" hint={`Explica qué pasó. Máximo ${REASON_MAX} caracteres; ${reasonLength} usados.`} error={errors.reason}>
            {(p) => <textarea {...p} rows={3} maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} required />}
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={contingency} onChange={(e) => setContingency(e.target.checked)} />
            Ocurrió durante una caída de conexión (procedimiento de contingencia)
          </label>
          <LiveRegion tone="error" message={error} />
          <div className="button-row">
            <button type="submit" className="btn btn-primary">Revisar solicitud</button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      ) : (
        <div>
          <p>Revisa la solicitud antes de enviarla:</p>
          <ul className="review-list">
            {operations.map((op, index) => <li key={index}>{describeOperation(op, items, zone)}</li>)}
          </ul>
          <p><strong>Motivo:</strong> {(contingency ? CONTINGENCY : '') + reason.trim()}</p>
          <LiveRegion tone="error" message={error} />
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={pending || baseVersion === null}>
              {pending ? 'Enviando…' : 'Enviar solicitud'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setStep('edit')} disabled={pending}>Volver a editar</button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

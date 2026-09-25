import { sessionTotals, sortEvents } from '../domain/durations';
import { originalFate, type EvidenceSession } from '../domain/evidence';
import { EVENT_LABEL, SOURCE_LABEL } from '../domain/labels';
import { formatDate, formatDateTime, formatShortDate, formatTime, zoneLabel } from '../lib/time';
import { Badge, Duration, TableWrap } from '../ui/components';

const FATE_LABEL = { VIGENTE: 'Vigente', SUSTITUIDO: 'Sustituido por una corrección', ANULADO: 'Anulado por una corrección' };
const OPERATION_LABEL = { ADD: 'Añadido', REPLACE: 'Cambio de hora', VOID: 'Anulación' };

// One work session: effective timeline, informative totals, and the immutable
// originals plus approved adjustments that produced it.
export function SessionView({ session, headingLevel = 3, onCorrect }: {
  session: EvidenceSession; headingLevel?: 2 | 3; onCorrect?: () => void;
}) {
  const events = sortEvents(session.effective);
  const totals = sessionTotals(events, session.policy.break_counts_as_work);
  const zone = session.timezone;
  const entry = events[0]?.effective_at ?? session.originals[0]?.server_at;
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const headingId = `session-${session.id}`;
  return (
    <article className="session" aria-labelledby={headingId}>
      <div className="session-header">
        <Heading id={headingId}>{entry ? formatDate(entry, zone) : 'Jornada sin fichajes vigentes'}</Heading>
        <div className="badges">
          {totals.closed ? <Badge tone="success">Completa</Badge>
            : totals.valid ? <Badge tone="warning">Abierta: incompleta</Badge>
              : <Badge tone="danger">Sin entrada vigente</Badge>}
          {session.adjustments.length > 0 && <Badge>Con correcciones</Badge>}
        </div>
      </div>
      {events.length > 0 ? (
        <TableWrap label={entry ? `Fichajes de la jornada iniciada el ${formatDate(entry, zone)} a las ${formatTime(entry, zone, true)}` : `Fichajes de la jornada ${session.id.slice(0, 8)}`}>
        <table className="table">
          <caption className="visually-hidden">Fichajes vigentes de la jornada {entry ? formatDate(entry, zone) : ''}</caption>
          <thead><tr><th scope="col">Fichaje</th><th scope="col">Hora</th><th scope="col">Origen</th></tr></thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.adjustment_id ?? event.event_id ?? `${event.effective_at}-${event.ordinal}`}>
                <th scope="row">{EVENT_LABEL[event.event_type]}</th>
                <td className="time">{formatTime(event.effective_at, zone, true)}</td>
                <td>{SOURCE_LABEL[event.source]}{event.source === 'CORRECTION' && event.server_at
                  ? ` (original: ${formatTime(event.server_at, zone, true)})` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </TableWrap>
      ) : <p>Todos los fichajes de esta jornada fueron anulados por correcciones aprobadas.</p>}
      {totals.closed && totals.grossSeconds !== null ? (
        <dl className="totals">
          <div><dt>Duración bruta</dt><dd><Duration seconds={totals.grossSeconds} /></dd></div>
          <div><dt>Pausas</dt><dd><Duration seconds={totals.breakSeconds ?? 0} /></dd></div>
          <div><dt>Neta</dt><dd><Duration seconds={totals.netSeconds ?? 0} /></dd></div>
          <div><dt>Computable</dt><dd><Duration seconds={totals.computableSeconds ?? 0} /></dd></div>
        </dl>
      ) : (
        <p className="incident"><strong>Incidencia:</strong> jornada sin salida registrada. No se calculan horas hasta que se complete o se corrija; nunca se cuenta como cero.</p>
      )}
      <p className="hint">
        Horario versión {session.policy.version}: pausas {session.policy.break_counts_as_work ? 'computables' : 'no computables'}. Zona: {zoneLabel(zone)}.
        Totales informativos calculados a partir del registro del servidor.
      </p>
      <details className="details">
        <summary>Registros originales y correcciones</summary>
        <h4>Fichajes originales (no se modifican nunca)</h4>
        <ul>
          {[...session.originals].sort((a, b) => a.sequence - b.sequence).map((original) => (
            <li key={original.id}>
              {EVENT_LABEL[original.event_type]} · {formatShortDate(original.server_at, zone)} {formatTime(original.server_at, zone, true)} (hora del servidor) · {original.source === 'KIOSK' ? 'kiosco' : 'web'} · {FATE_LABEL[originalFate(original, session)]}
            </li>
          ))}
          {session.originals.length === 0 && <li>Jornada añadida por corrección, sin fichajes originales.</li>}
        </ul>
        {session.adjustments.length > 0 && (
          <>
            <h4>Correcciones aprobadas</h4>
            <ul>
              {session.adjustments.map(({ adjustment, decision }) => (
                <li key={adjustment.id}>
                  {OPERATION_LABEL[adjustment.operation]}
                  {adjustment.event_type ? ` · ${EVENT_LABEL[adjustment.event_type]}` : ''}
                  {adjustment.effective_at ? ` · ${formatDateTime(adjustment.effective_at, zone)}` : ''}
                  {` · aprobada el ${formatDateTime(decision.created_at, zone)}`}
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
      {onCorrect && (
        <button type="button" className="btn btn-secondary" onClick={onCorrect}>Solicitar corrección de esta jornada</button>
      )}
    </article>
  );
}

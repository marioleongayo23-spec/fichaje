import { useRef, useState, type FormEvent } from 'react';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { isManager } from '../domain/labels';
import type { Employee } from '../domain/types';
import { newRequestId, postJson, rpc } from '../lib/api';
import { ApiError, asApiError, errorMessage } from '../lib/errors';
import { currentMonth, daysBetween, DEFAULT_ZONE, formatDateTime, monthRange, previousMonth, ZONES, type SpanishZone } from '../lib/time';
import { Dialog, EmptyState, Field, LiveRegion } from '../ui/components';

interface Job { id: string; label: string; cutoffAt: string; expiresAt: string; status: 'PENDING' | 'READY' | 'DOWNLOADED' | 'UNAVAILABLE'; delivered?: string }

// Export jobs requested in this session are kept in memory only. A signed link
// is requested on each click, used immediately and never stored or cached.
export function ExportPanel({ employees, ownEmployeeId }: { employees: Employee[] | null; ownEmployeeId: string | null }) {
  const { client, config } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const manager = isManager(tenant.role) && employees !== null;
  const last = monthRange(previousMonth(currentMonth(DEFAULT_ZONE)));
  const [range, setRange] = useState({ start: last.start, end: last.end });
  const [zone, setZone] = useState<SpanishZone>(DEFAULT_ZONE);
  const [subject, setSubject] = useState<string>(manager ? '' : ownEmployeeId ?? '');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [delivering, setDelivering] = useState<Job | null>(null);
  // A retried request with identical filters reuses its request_id (same job).
  const attempt = useRef<{ key: string; requestId: string } | null>(null);

  const generate = async (jobId: string, token: string) => {
    const result = await postJson<{ status: string }>(config.exportLinkUrl + '/generate', token,
      { organization_id: org, job_id: jobId }, 'export.link', true, 45000);
    if (result.status !== 'READY') throw new ApiError('server', 'SERVER');
  };

  const request = async (event: FormEvent) => {
    event.preventDefault();
    setStatus(null);
    if (!range.start || !range.end || range.end < range.start) { setError('La fecha final debe ser igual o posterior a la inicial.'); return; }
    if (daysBetween(range.start, range.end) > 366) { setError('El periodo máximo es de un año.'); return; }
    setError(null);
    setPending(true);
    const key = JSON.stringify([subject, range, zone]);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    try {
      const job = await rpc<{ job_id: string; cutoff_at: string; expires_at: string }>(client, 'request_export', {
        p_organization_id: org, p_request_id: attempt.current.requestId, p_employee_id: subject || null,
        p_start: range.start, p_end: range.end, p_timezone: zone,
      });
      const who = manager ? (employees?.find((e) => e.id === subject)?.display_name ?? 'Toda la organización') : 'Mi registro';
      attempt.current = null;
      const next: Job = { id: job.job_id, label: `${who}: ${range.start} a ${range.end}`, cutoffAt: job.cutoff_at, expiresAt: job.expires_at, status: 'PENDING' };
      setJobs((list) => [next, ...list]);
      setStatus('Exportación solicitada. Preparando el paquete…');
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new ApiError('unauthenticated', 'UNAUTHENTICATED');
      try {
        await generate(job.job_id, token);
        setJobs((list) => list.map((j) => j.id === job.job_id ? { ...j, status: 'READY' } : j));
        setStatus('Paquete preparado. Ya puedes descargarlo.');
      } catch (generationFailure) {
        const generationError = asApiError(generationFailure);
        if (generationError.kind === 'forbidden') {
          setJobs((list) => list.map((j) => j.id === job.job_id ? { ...j, status: 'UNAVAILABLE' } : j));
          setError('No se ha podido preparar este paquete.');
        } else {
          setStatus('La solicitud está guardada. Pulsa «Descargar» para reintentar la preparación de forma segura.');
        }
      }
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const download = async (job: Job) => {
    setError(null);
    setStatus(null);
    try {
      const { data } = await client.auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new ApiError('unauthenticated', 'UNAUTHENTICATED');
      if (job.status === 'PENDING') {
        await generate(job.id, token);
        setJobs((list) => list.map((j) => j.id === job.id ? { ...j, status: 'READY' } : j));
      }
      const link = await postJson<{ url: string; expires_in: number }>(config.exportLinkUrl, token, { organization_id: org, job_id: job.id }, 'export.link', false);
      if (typeof link.url !== 'string' || !/^https?:\/\//.test(link.url)) throw new ApiError('server', 'SERVER');
      const anchor = document.createElement('a');
      anchor.href = link.url;
      anchor.rel = 'noopener noreferrer';
      anchor.referrerPolicy = 'no-referrer';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setJobs((list) => list.map((j) => j.id === job.id ? { ...j, status: 'DOWNLOADED' } : j));
      setStatus('Descarga iniciada. El enlace caduca en unos minutos y no se guarda.');
    } catch (failure) {
      const apiError = asApiError(failure);
      if (apiError.kind === 'forbidden') {
        setJobs((list) => list.map((j) => j.id === job.id ? { ...j, status: 'UNAVAILABLE' } : j));
        setError('El paquete todavía no está listo, ha caducado o ya no tienes acceso. Si acabas de solicitarlo, inténtalo de nuevo en unos minutos.');
        void tenant.reload();
      } else {
        setError(errorMessage(failure));
      }
    }
  };

  return (
    <>
      <form noValidate onSubmit={request} className="filters">
        {manager && (
          <Field label="Alcance">
            {(p) => (
              <select {...p} value={subject} onChange={(e) => setSubject(e.target.value)}>
                <option value="">Toda la organización</option>
                {employees?.map((e) => <option key={e.id} value={e.id}>{e.display_name} ({e.code})</option>)}
              </select>
            )}
          </Field>
        )}
        <Field label="Desde">{(p) => <input {...p} type="date" value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} />}</Field>
        <Field label="Hasta">{(p) => <input {...p} type="date" value={range.end} onChange={(e) => setRange({ ...range, end: e.target.value })} />}</Field>
        <Field label="Zona horaria">
          {(p) => (
            <select {...p} value={zone} onChange={(e) => setZone(e.target.value as SpanishZone)}>
              {ZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
            </select>
          )}
        </Field>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Solicitando…' : 'Solicitar exportación'}</button>
      </form>
      <p className="hint">Paquete CSV + JSON + PDF con fichajes originales, correcciones y totales. Se conserva 24 horas; cada descarga genera un enlace temporal de 5 minutos como máximo.</p>
      <LiveRegion tone="info" message={status} />
      <LiveRegion tone="error" message={error} />
      <h2>Solicitadas en esta sesión</h2>
      {jobs.length === 0 ? <EmptyState>No has solicitado exportaciones en esta sesión.</EmptyState> : (
        <ul className="card-list">
          {jobs.map((job) => (
            <li key={job.id} className="card">
              <h3 className="card-title">{job.label}</h3>
              <p>Corte: {formatDateTime(job.cutoffAt, zone)} · disponible hasta {formatDateTime(job.expiresAt, zone)}.</p>
              <p><strong>Estado:</strong> {job.status === 'PENDING' ? 'Pendiente de preparación'
                : job.status === 'READY' ? 'Lista para descargar'
                : job.status === 'DOWNLOADED' ? 'Descarga iniciada' : 'No disponible en este momento'}
                {job.delivered ? ` · Entrega registrada (${job.delivered})` : ''}</p>
              <div className="button-row">
                <button type="button" className="btn btn-secondary" onClick={() => void download(job)}>Descargar</button>
                {manager && <button type="button" className="btn btn-secondary" onClick={() => setDelivering(job)}>Registrar entrega controlada</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      {delivering && (
        <DeliveryDialog job={delivering} onClose={() => setDelivering(null)}
          onDone={(reference) => { setJobs((list) => list.map((j) => j.id === delivering.id ? { ...j, delivered: reference } : j)); setDelivering(null); setStatus('Entrega registrada y auditada.'); }} />
      )}
    </>
  );
}

function DeliveryDialog({ job, onClose, onDone }: { job: Job; onClose: () => void; onDone: (reference: string) => void }) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = String(form.get('kind') ?? '');
    const reference = String(form.get('reference') ?? '').trim();
    const purpose = String(form.get('purpose') ?? '').trim();
    if (!reference || reference.length > 200 || !purpose || purpose.length > 1000) { setError('Indica la referencia del recibo (máx. 200) y la finalidad (máx. 1000).'); return; }
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'record_evidence_delivery', { p_org: tenant.current.organization.id, p_job: job.id, p_recipient_kind: kind, p_receipt_ref: reference, p_purpose: purpose });
      onDone(reference);
    } catch (failure) {
      tenant.handleError(failure);
      setError(asApiError(failure).kind === 'forbidden'
        ? 'Solo quien solicitó la exportación puede registrar su entrega, y el paquete debe estar listo y vigente.'
        : errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open title="Registrar entrega controlada" onClose={onClose}>
      <form noValidate onSubmit={submit}>
        <p className="hint">Deja constancia auditada de la entrega de «{job.label}». No crea cuentas ni enlaces públicos.</p>
        <Field label="Destinatario">
          {(p) => (
            <select {...p} name="kind" defaultValue="REPRESENTATIVE">
              <option value="REPRESENTATIVE">Representación legal de las personas trabajadoras</option>
              <option value="INSPECTION">Inspección de Trabajo y Seguridad Social</option>
            </select>
          )}
        </Field>
        <Field label="Referencia del recibo">{(p) => <input {...p} name="reference" maxLength={200} autoComplete="off" />}</Field>
        <Field label="Finalidad">{(p) => <textarea {...p} name="purpose" rows={3} maxLength={1000} />}</Field>
        <LiveRegion tone="error" message={error} />
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Registrando…' : 'Registrar entrega'}</button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Dialog>
  );
}

import { useState } from 'react';
import { useAuth } from '../app/auth';
import { useLoader } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { rpc } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { Badge, LiveRegion, Loading, Notice, PageHeader } from '../ui/components';
import { beginCheckout, monthlyCents, openPortal, syncSeats, type BillingStatus, type BillingSummary } from './client';

const STATUS: Record<BillingStatus, string> = {
  NOT_CONFIGURED: 'Sin suscripción',
  CHECKOUT_PENDING: 'Pago iniciado',
  INCOMPLETE: 'Pendiente de pago',
  INCOMPLETE_EXPIRED: 'Pago caducado',
  TRIALING: 'Periodo de prueba',
  ACTIVE: 'Activa',
  PAST_DUE: 'Pago pendiente',
  PAUSED: 'Pausada',
  UNPAID: 'Impagada',
  CANCELED: 'Cancelada',
};
const SUBSCRIBED = new Set<BillingStatus>(['INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED', 'UNPAID']);

function money(cents: number): string {
  return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}
function period(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(date);
}

export function BillingPage() {
  const { client, config } = useServices();
  const { session } = useAuth();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const summary = useLoader(() => rpc<BillingSummary>(client, 'get_billing_summary', { p_organization_id: org }), [client, org]);
  const [pending, setPending] = useState<'checkout' | 'portal' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const callback = new URLSearchParams(window.location.search).get('checkout');

  const external = async (action: 'checkout' | 'portal') => {
    if (!session || !config.billingEnabled) return;
    setPending(action); setError(null); setDone(null);
    try {
      const url = action === 'checkout'
        ? await beginCheckout(config, session.access_token, org)
        : await openPortal(config, session.access_token, org);
      window.location.assign(url);
    } catch (failure) {
      setError(errorMessage(failure));
      setPending(null);
    }
  };

  const reconcile = async () => {
    if (!session || !config.billingEnabled) return;
    setPending('sync'); setError(null); setDone(null);
    try {
      const result = await syncSeats(config, session.access_token, org);
      setDone(result.status === 'PENDING'
        ? 'Stripe ha recibido la actualización; queda otra revisión pendiente.'
        : result.status === 'NO_SUBSCRIPTION'
          ? 'Todavía no existe una suscripción que sincronizar.'
          : 'Número de empleados sincronizado con la suscripción.');
      await summary.reload();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(null);
    }
  };

  const data = summary.data;
  const employees = data?.active_employees ?? 0;
  const subscribed = data ? SUBSCRIBED.has(data.status) : false;
  const end = data ? period(data.current_period_end) : null;

  return (
    <>
      <PageHeader title="Facturación">
        <p>Contratación y suscripción de {tenant.current.organization.name}. Solo la persona OWNER puede gestionar esta sección.</p>
      </PageHeader>
      {callback === 'success' && <Notice tone="info" title="Checkout completado. Estamos confirmando la suscripción."><p>La vuelta desde Stripe no activa nada por sí sola: el estado autoritativo llega por webhook firmado. Actualiza esta pantalla si tarda unos segundos.</p></Notice>}
      {callback === 'cancel' && <Notice tone="info" title="No se ha completado el pago. Puedes retomarlo cuando quieras." />}
      {!config.billingEnabled && <Notice tone="warning" title="Facturación desactivada en este entorno."><p>El código de Stripe está cerrado por defecto. Para una demo de pago debe habilitarse únicamente en test mode.</p></Notice>}
      <LiveRegion tone="error" message={error} />
      <LiveRegion tone="success" message={done} />
      {summary.loading && <Loading label="Consultando la suscripción…" />}
      {summary.error && <Notice tone="error" title={summary.error} />}
      {data && (
        <>
          <section className="subsection billing-summary" aria-labelledby="billing-status-title">
            <p className="bundy-step-label">SUSCRIPCIÓN</p>
            <h2 id="billing-status-title">Estado</h2>
            <div className="billing-grid">
              <div><span>Estado</span><strong><Badge tone={data.status === 'ACTIVE' || data.status === 'TRIALING' ? 'success' : data.status === 'PAST_DUE' || data.status === 'UNPAID' ? 'warning' : 'neutral'}>{STATUS[data.status]}</Badge></strong></div>
              <div><span>Empleados activos</span><strong>{employees}</strong></div>
              <div><span>Estimación mensual</span><strong>{money(monthlyCents(employees))}</strong></div>
              {end && <div><span>Periodo actual hasta</span><strong>{end}</strong></div>}
            </div>
            {data.cancel_at_period_end && <Notice tone="warning" title="La suscripción está programada para cancelarse al final del periodo." />}
            {data.seat_sync_pending && subscribed && <Notice tone="warning" title="Hay un cambio de empleados pendiente de sincronizar con Stripe." />}
          </section>
          <section className="subsection" aria-labelledby="billing-plan-title">
            <p className="bundy-step-label">PLAN BUNDY</p>
            <h2 id="billing-plan-title">12,99 € al mes</h2>
            <p>Incluye hasta 5 empleados. Del 6 al 20: 1,99 €/empleado; del 21 al 100: 1,49 €; desde 101: 1,29 €. La cantidad se calcula en servidor con los empleados activos.</p>
            <div className="button-row">
              {!subscribed && <button type="button" className="btn btn-primary" disabled={!config.billingEnabled || pending !== null} onClick={() => void external('checkout')}>{pending === 'checkout' ? 'Abriendo Stripe…' : data.status === 'CHECKOUT_PENDING' ? 'Continuar pago seguro' : 'Contratar con Stripe'}</button>}
              {subscribed && <button type="button" className="btn btn-secondary" disabled={!config.billingEnabled || pending !== null} onClick={() => void external('portal')}>{pending === 'portal' ? 'Abriendo portal…' : 'Gestionar pago y facturas'}</button>}
              {data.seat_sync_pending && subscribed && <button type="button" className="btn btn-secondary" disabled={!config.billingEnabled || pending !== null} onClick={() => void reconcile()}>{pending === 'sync' ? 'Sincronizando…' : 'Sincronizar empleados'}</button>}
              <button type="button" className="btn btn-link" disabled={summary.loading} onClick={() => void summary.reload()}>Actualizar estado</button>
            </div>
            <p className="hint">El pago se realiza en una página alojada por Stripe. Bundy no recibe ni almacena PAN, CVC ni datos completos de tarjeta.</p>
          </section>
        </>
      )}
    </>
  );
}

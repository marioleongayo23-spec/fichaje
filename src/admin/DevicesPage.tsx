import { useRef, useState, type FormEvent } from 'react';
import { useLoader } from '../app/hooks';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { newRequestId, select } from '../lib/api';
import { encodeDeviceSetup } from '../lib/codes';
import { createDeliveryKeys, openDelivery, type DeliveryKeys } from '../lib/crypto';
import { asApiError, errorMessage } from '../lib/errors';
import { DEFAULT_ZONE, formatDateTime, localDate } from '../lib/time';
import { Badge, Dialog, EmptyState, Field, LiveRegion, Loading, Notice, PageHeader, TableWrap } from '../ui/components';
import { gateway } from './data';

interface DeviceRow { id: string; provisionedAt: string; revokedAt: string | null }

// There is no device-listing RPC. OWNER/ADMIN may read their tenant's audit log
// (RLS), so provisioned/revoked devices are derived from those two actions only.
export function DevicesPage() {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const [provisioning, setProvisioning] = useState(false);
  const [revoking, setRevoking] = useState<DeviceRow | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const devices = useLoader(async () => {
    const rows = await select<{ entity_id: string; action: string; server_at: string }>(client.from('audit_log')
      .select('entity_id,action,server_at').eq('organization_id', org).in('action', ['kiosk_provision', 'kiosk_revoke']).order('server_at'));
    const map = new Map<string, DeviceRow>();
    for (const row of rows) {
      if (row.action === 'kiosk_provision') map.set(row.entity_id, { id: row.entity_id, provisionedAt: row.server_at, revokedAt: null });
      else { const device = map.get(row.entity_id); if (device && !device.revokedAt) device.revokedAt = row.server_at; }
    }
    return [...map.values()].reverse();
  }, [client, org]);

  return (
    <>
      <PageHeader title="Kioscos">
        <p>Dispositivos compartidos para fichar con código y PIN, pensados para personas sin correo. El kiosco no puede ver el directorio, exportaciones ni la gestión.</p>
      </PageHeader>
      <button type="button" className="btn btn-primary" onClick={() => { setStatus(null); setProvisioning(true); }}>Preparar un kiosco</button>
      <LiveRegion tone="success" message={status} />
      {devices.loading && <Loading />}
      {devices.error && <Notice tone="error" title={devices.error} />}
      {devices.data && (devices.data.length === 0 ? <EmptyState>No hay kioscos preparados.</EmptyState> : (
        <TableWrap label="Kioscos de la organización">
          <table className="table">
            <caption className="visually-hidden">Kioscos de la organización</caption>
            <thead><tr><th scope="col">Dispositivo</th><th scope="col">Preparado</th><th scope="col">Situación</th><th scope="col"><span className="visually-hidden">Acciones</span></th></tr></thead>
            <tbody>
              {devices.data.map((d) => (
                <tr key={d.id}>
                  <th scope="row">Kiosco terminado en {d.id.slice(-6)}</th>
                  <td>{formatDateTime(d.provisionedAt, DEFAULT_ZONE)}</td>
                  <td>{d.revokedAt ? <Badge>Revocado el {formatDateTime(d.revokedAt, DEFAULT_ZONE)}</Badge> : <Badge tone="success">Autorizado</Badge>}</td>
                  <td>{!d.revokedAt && <button type="button" className="btn btn-danger btn-small" onClick={() => { setStatus(null); setRevoking(d); }}>Revocar<span className="visually-hidden"> kiosco terminado en {d.id.slice(-6)}</span></button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ))}
      {provisioning && <ProvisionDialog onClose={() => { setProvisioning(false); void devices.reload(); }} />}
      {revoking && <RevokeDialog device={revoking} onClose={() => setRevoking(null)}
        onDone={() => { setRevoking(null); setStatus('Kiosco revocado. Deja de funcionar de inmediato, aunque conserve su sesión.'); void devices.reload(); }} />}
    </>
  );
}

function ProvisionDialog({ onClose }: { onClose: () => void }) {
  const { client, config } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const [setupCode, setSetupCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const defaultExpiry = localDate(new Date(Date.now() + 365 * 86400_000), DEFAULT_ZONE);
  const attempt = useRef<{ key: string; requestId: string; deviceId: string; keys: DeliveryKeys } | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const expiry = String(form.get('expiry') ?? '');
    const expiresAt = new Date(`${expiry}T23:59:00Z`);
    if (!name || name.length > 100) { setError('El nombre es obligatorio (máximo 100 caracteres).'); return; }
    if (!expiry || Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) { setError('La caducidad debe ser una fecha futura.'); return; }
    setPending(true);
    setError(null);
    try {
      const key = JSON.stringify([name, expiry]);
      if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId(), deviceId: crypto.randomUUID(), keys: await createDeliveryKeys() };
      const { requestId, deviceId, keys } = attempt.current;
      const receipt = await gateway<{ device_id: string; delivery: string }>(client, config.kioskGatewayUrl, 'provision', {
        organization_id: org, request_id: requestId, device_id: deviceId, name, expires_at: expiresAt.toISOString(), delivery_key: keys.publicJwk,
      });
      const credential = JSON.parse(await openDelivery(keys.privateKey, receipt.delivery)) as { email: string; password: string };
      attempt.current = null;
      setSetupCode(encodeDeviceSetup({ organizationId: org, deviceId: receipt.device_id, email: credential.email, password: credential.password }));
    } catch (failure) {
      const apiError = asApiError(failure);
      tenant.handleError(failure);
      setError(apiError.kind === 'network' || apiError.kind === 'timeout'
        ? 'No sabemos si se preparó el kiosco. Pulsa «Preparar» de nuevo con los mismos datos: se recupera el mismo, sin crear otro.'
        : apiError.kind === 'forbidden' ? 'No se ha podido preparar el kiosco. Revisa los datos y tus permisos.' : errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open title="Preparar un kiosco" onClose={() => { setSetupCode(null); onClose(); }}>
      {setupCode ? (
        <>
          <p>Abre <strong>/kiosco</strong> en el dispositivo y pega este código de configuración. Contiene la credencial técnica del dispositivo: no la compartas ni la guardes.</p>
          <p className="secret-value secret-code">{setupCode}</p>
          <p className="hint">No se volverá a mostrar. Si se pierde, revoca este kiosco y prepara otro.</p>
          <button type="button" className="btn btn-primary" onClick={() => { setSetupCode(null); onClose(); }}>He configurado el dispositivo; cerrar</button>
        </>
      ) : (
        <form noValidate onSubmit={submit}>
          <Field label="Nombre del kiosco" hint="Por ejemplo, «Entrada almacén». Máximo 100 caracteres.">
            {(p) => <input {...p} name="name" maxLength={100} autoComplete="off" />}
          </Field>
          <Field label="Autorizado hasta">{(p) => <input {...p} name="expiry" type="date" defaultValue={defaultExpiry} />}</Field>
          <LiveRegion tone="error" message={error} />
          <div className="button-row">
            <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Preparando…' : 'Preparar'}</button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function RevokeDialog({ device, onClose, onDone }: { device: DeviceRow; onClose: () => void; onDone: () => void }) {
  const { client, config } = useServices();
  const tenant = useCurrentTenant();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const requestId = useRef(newRequestId());
  const revoke = async () => {
    setPending(true);
    setError(null);
    try {
      await gateway(client, config.kioskGatewayUrl, 'revoke', { organization_id: tenant.current.organization.id, request_id: requestId.current, device_id: device.id });
      onDone();
    } catch (failure) {
      tenant.handleError(failure);
      setError(asApiError(failure).kind === 'forbidden' ? 'No se ha podido revocar. Comprueba tus permisos.' : errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open title="Revocar kiosco" onClose={onClose}>
      <p>El kiosco terminado en {device.id.slice(-6)} dejará de funcionar de inmediato. No se puede reactivar: habría que preparar otro.</p>
      <LiveRegion tone="error" message={error} />
      <div className="button-row">
        <button type="button" className="btn btn-danger" onClick={() => void revoke()} disabled={pending}>{pending ? 'Revocando…' : 'Revocar'}</button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
      </div>
    </Dialog>
  );
}

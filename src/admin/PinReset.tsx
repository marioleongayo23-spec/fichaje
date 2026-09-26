import { useRef, useState } from 'react';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import type { Employee } from '../domain/types';
import { newRequestId } from '../lib/api';
import { createDeliveryKeys, openDelivery, type DeliveryKeys } from '../lib/crypto';
import { asApiError, errorMessage } from '../lib/errors';
import { Dialog, LiveRegion } from '../ui/components';
import { gateway } from './data';

// The H4 gateway generates the PIN and encrypts it to a key created here. The
// PIN is decrypted in memory, shown once and discarded when the dialog closes.
export function PinReset({ employee }: { employee: Employee }) {
  const { client, config } = useServices();
  const tenant = useCurrentTenant();
  const [confirming, setConfirming] = useState(false);
  const [pin, setPin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ requestId: string; keys: DeliveryKeys } | null>(null);

  const reset = async () => {
    setPending(true);
    setError(null);
    try {
      // A retry after an unknown outcome resends the same request and key: the
      // gateway returns the same sealed PIN and never issues a second one.
      if (!attempt.current) attempt.current = { requestId: newRequestId(), keys: await createDeliveryKeys() };
      const { requestId, keys } = attempt.current;
      const receipt = await gateway<{ delivery: string }>(client, config.kioskGatewayUrl, 'reset', {
        organization_id: tenant.current.organization.id, request_id: requestId, employee_id: employee.id, delivery_key: keys.publicJwk,
      });
      const value = await openDelivery(keys.privateKey, receipt.delivery);
      if (!/^\d{8}$/.test(value)) throw new Error('INVALID_DELIVERY');
      attempt.current = null;
      setConfirming(false);
      setPin(value);
    } catch (failure) {
      const apiError = asApiError(failure);
      tenant.handleError(failure);
      setError(apiError.kind === 'network' || apiError.kind === 'timeout'
        ? 'No sabemos si se generó el PIN. Pulsa «Generar PIN» otra vez: se recupera el mismo, sin crear otro.'
        : apiError.kind === 'forbidden' ? 'No se ha podido generar el PIN. Comprueba que la persona esté activa y que tengas permiso.' : errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const close = () => { setPin(null); setConfirming(false); setError(null); };
  return (
    <>
      <button type="button" className="btn btn-secondary" onClick={() => { setError(null); setConfirming(true); }} disabled={!employee.active}>
        Generar PIN de kiosco
      </button>
      {!employee.active && <p className="hint">Solo se genera PIN para personas activas.</p>}
      <Dialog open={confirming || pin !== null} title={pin ? 'PIN de kiosco generado' : 'Generar PIN de kiosco'} onClose={close}>
        {pin ? (
          <>
            <p>PIN para <strong>{employee.display_name}</strong> (código {employee.code}):</p>
            <p className="secret-value" aria-label={`PIN: ${pin.split('').join(' ')}`}>{pin.slice(0, 4)} {pin.slice(4)}</p>
            <p>Entrégalo en persona. No se volverá a mostrar ni se puede recuperar: si se pierde, genera otro. Los PIN anteriores dejan de funcionar.</p>
            <button type="button" className="btn btn-primary" onClick={close}>He entregado el PIN; cerrar</button>
          </>
        ) : (
          <>
            <p>Se generará un PIN nuevo de 8 dígitos para <strong>{employee.display_name}</strong>. El PIN anterior dejará de funcionar. Un bloqueo por intentos fallidos sigue vigente hasta que caduque.</p>
            <LiveRegion tone="error" message={error} />
            <div className="button-row">
              <button type="button" className="btn btn-primary" onClick={() => void reset()} disabled={pending}>{pending ? 'Generando…' : 'Generar PIN'}</button>
              <button type="button" className="btn btn-secondary" onClick={close} disabled={pending}>Cancelar</button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}

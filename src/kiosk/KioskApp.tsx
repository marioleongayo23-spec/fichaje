import { useEffect, useMemo, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { BRAND, type AppConfig } from '../config';
import { useNow } from '../app/hooks';
import { isUuid, parseDeviceSetup } from '../lib/codes';
import { useOnline } from '../lib/online';
import { clearStoredSession, KIOSK_DEVICE_KEY, KIOSK_STORAGE_KEY } from '../lib/storage';
import { createSessionClient } from '../lib/supabase';
import { startTelemetry } from '../lib/telemetry';
import { formatDate, formatTime } from '../lib/time';
import { Field, LiveRegion, Loading, Notice } from '../ui/components';
import { HttpKioskGateway, type KioskGateway, type KioskIdentity } from './gateway';
import { KioskTerminal } from './KioskTerminal';

function readDevice(): KioskIdentity | null {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(KIOSK_DEVICE_KEY) ?? 'null');
    if (!value || typeof value !== 'object') return null;
    const { organizationId, deviceId } = value as Record<string, unknown>;
    return isUuid(organizationId) && isUuid(deviceId) ? { organizationId, deviceId } : null;
  } catch {
    return null;
  }
}

// Kiosk mode: its own Supabase client and storage key (technical device
// identity, never a human session), no navigation to management or exports.
export function KioskApp({ config }: { config: AppConfig }) {
  const client = useMemo(() => createSessionClient(config.supabase, KIOSK_STORAGE_KEY, window.localStorage), [config]);
  const [device, setDevice] = useState<KioskIdentity | null>(readDevice);
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const online = useOnline();
  const now = useNow();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => { document.title = `Kiosco · ${BRAND}`; }, []);
  useEffect(() => startTelemetry(client), [client]);
  useEffect(() => {
    let active = true;
    client.auth.getSession().then(({ data }) => { if (active) setSession(data.session); }).catch(() => { if (active) setSession(null); });
    const { data } = client.auth.onAuthStateChange((_event, next) => { if (active) setSession(next); });
    return () => { active = false; data.subscription.unsubscribe(); };
  }, [client]);

  const gateway: KioskGateway | null = useMemo(() => device ? new HttpKioskGateway(config.kioskGatewayUrl, device,
    async () => (await client.auth.getSession()).data.session?.access_token ?? null) : null, [client, config, device]);

  const unconfigure = async () => {
    await client.auth.signOut({ scope: 'local' }).catch(() => undefined);
    clearStoredSession(KIOSK_STORAGE_KEY);
    window.localStorage.removeItem(KIOSK_DEVICE_KEY);
    setDevice(null);
    setSession(null);
  };

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <p className="brand-mark">{BRAND} · Kiosco</p>
        <p className="kiosk-clock">
          <span className="visually-hidden">Hora de este dispositivo: </span>
          <span>{formatTime(now, zone)}</span>
          <span className="kiosk-date">{formatDate(now, zone)}</span>
        </p>
      </header>
      <main id="contenido" className="kiosk-main">
        <h1 className="visually-hidden">Kiosco de fichaje</h1>
        <div role="status" className="live-region">
          {!online && <p className="offline-banner"><strong>Sin conexión.</strong> No se puede fichar. Sigue el procedimiento de contingencia de tu empresa y solicita después una corrección.</p>}
        </div>
        {session === undefined ? <Loading /> : !device || !session ? (
          <DeviceSetup client={client} expired={Boolean(device) && !session} onConfigured={(identity) => {
            window.localStorage.setItem(KIOSK_DEVICE_KEY, JSON.stringify(identity));
            setDevice(identity);
          }} />
        ) : gateway ? (
          <KioskTerminal gateway={gateway} online={online} />
        ) : <Loading />}
        {device && session && (
          <details className="details kiosk-options">
            <summary>Opciones del dispositivo</summary>
            <p>Retirar la configuración cierra la sesión técnica de este dispositivo. Para impedir su uso definitivamente, revócalo desde «Kioscos» en la gestión.</p>
            <button type="button" className="btn btn-secondary" onClick={() => void unconfigure()}>Retirar configuración de este dispositivo</button>
          </details>
        )}
      </main>
    </div>
  );
}

function DeviceSetup({ client, expired, onConfigured }: {
  client: ReturnType<typeof createSessionClient>; expired: boolean; onConfigured: (identity: KioskIdentity) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const setup = parseDeviceSetup(String(new FormData(form).get('setup') ?? ''));
    form.reset();
    if (!setup) { setError('El código de configuración no es válido.'); return; }
    setPending(true);
    setError(null);
    try {
      const { error: authError } = await client.auth.signInWithPassword({ email: setup.email, password: setup.password });
      if (authError) { setError('No se ha podido configurar el dispositivo. Pide un código nuevo a tu empresa.'); return; }
      onConfigured({ organizationId: setup.organizationId, deviceId: setup.deviceId });
    } catch {
      setError('No hay conexión con el servicio. Inténtalo de nuevo.');
    } finally {
      setPending(false);
    }
  };
  return (
    <section aria-labelledby="setup-title" className="kiosk-form">
      <h2 id="setup-title">Configurar este dispositivo</h2>
      {expired && <Notice tone="warning" title="La autorización de este dispositivo ya no es válida. Vuelve a configurarlo." />}
      <p>Solo para la persona responsable de la empresa. Pega el código de configuración que se muestra al preparar el kiosco en «Gestión › Kioscos».</p>
      <form noValidate onSubmit={(e) => void submit(e)} autoComplete="off">
        <Field label="Código de configuración">
          {(p) => <input {...p} name="setup" type="password" autoComplete="off" spellCheck={false} />}
        </Field>
        <LiveRegion tone="error" message={error} />
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Configurando…' : 'Configurar'}</button>
      </form>
    </section>
  );
}

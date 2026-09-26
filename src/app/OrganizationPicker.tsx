import { useEffect, useRef, useState, type FormEvent } from 'react';
import { BRAND } from '../config';
import { ROLE_LABEL } from '../domain/labels';
import { newRequestId, rpc } from '../lib/api';
import { parseInvitation } from '../lib/codes';
import { asApiError, errorMessage } from '../lib/errors';
import { Field, LiveRegion, Notice } from '../ui/components';
import { useAuth } from './auth';
import { useServices } from './services';
import { useTenant } from './tenant';

export function OrganizationPicker() {
  const tenant = useTenant();
  const { signOut } = useAuth();
  const empty = tenant.entries.length === 0;
  useEffect(() => { document.title = `${empty ? 'Sin organización' : 'Elegir organización'} · ${BRAND}`; }, [empty]);
  return (
    <main id="contenido" className="auth-page">
      <div className="auth-card auth-card-wide">
        <p className="brand-mark" aria-hidden="true">{BRAND}</p>
        <h1>{empty ? 'No tienes acceso a ninguna organización' : 'Elige organización'}</h1>
        {tenant.notice && <Notice tone="warning" title={tenant.notice} />}
        {tenant.error && <Notice tone="error" title={tenant.error} />}
        {empty ? (
          <p>Si has recibido una invitación, introdúcela abajo. Si no, pide acceso a tu empresa.</p>
        ) : (
          <>
            <p>Tu cuenta pertenece a varias organizaciones. Sus datos nunca se mezclan: trabajarás solo con la que elijas.</p>
            <ul className="choice-list">
              {tenant.entries.map((entry) => (
                <li key={entry.organization.id}>
                  <button type="button" className="choice" onClick={() => tenant.select(entry.organization.id)}>
                    <span className="choice-title">{entry.organization.name}</span>
                    <span className="choice-meta">{ROLE_LABEL[entry.membership.role]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
        <AcceptInvitation />
        <button type="button" className="btn btn-secondary" onClick={() => void signOut()}>Cerrar sesión</button>
      </div>
    </main>
  );
}

function AcceptInvitation() {
  const { client } = useServices();
  const tenant = useTenant();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Same request_id while the same code is retried: the server replays the receipt.
  const attempt = useRef<{ code: string; requestId: string } | null>(null);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('invitation') ?? '').trim();
    const parsed = parseInvitation(code);
    setDone(null);
    if (!parsed) { setError('El código de invitación no tiene el formato correcto.'); return; }
    if (attempt.current?.code !== code) attempt.current = { code, requestId: newRequestId() };
    setError(null);
    setPending(true);
    try {
      await rpc(client, 'accept_invitation', { p_organization_id: parsed.organizationId, p_request_id: attempt.current.requestId, p_token: parsed.token });
      attempt.current = null;
      (event.target as HTMLFormElement).reset();
      setDone('Invitación aceptada. Ya puedes elegir la organización.');
      await tenant.reload();
    } catch (failure) {
      const apiError = asApiError(failure);
      setError(apiError.kind === 'forbidden'
        ? 'La invitación no es válida: puede haber caducado, estar ya usada o no corresponder a tu correo verificado.'
        : errorMessage(apiError));
    } finally {
      setPending(false);
    }
  };

  return (
    <section aria-labelledby="accept-title" className="subsection">
      <h2 id="accept-title">Aceptar una invitación</h2>
      <form noValidate onSubmit={onSubmit}>
        <Field label="Código de invitación" hint="Te lo entrega tu empresa en persona o por un canal seguro. Caduca a las 24 horas.">
          {(p) => <input {...p} name="invitation" type="text" autoComplete="off" spellCheck={false} autoCapitalize="none" />}
        </Field>
        <LiveRegion tone="error" message={error} />
        <LiveRegion tone="success" message={done} />
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Aceptando…' : 'Aceptar invitación'}</button>
      </form>
    </section>
  );
}

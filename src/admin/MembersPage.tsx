import { useRef, useState, type FormEvent } from 'react';
import { useServices } from '../app/services';
import { useCurrentTenant } from '../app/tenant';
import { ROLE_LABEL } from '../domain/labels';
import type { Membership, Role } from '../domain/types';
import { newRequestId, rpc } from '../lib/api';
import { encodeInvitation } from '../lib/codes';
import { randomHex, sha256Hex } from '../lib/crypto';
import { errorMessage } from '../lib/errors';
import { DEFAULT_ZONE, formatDateTime } from '../lib/time';
import { Badge, Dialog, EmptyState, Field, LiveRegion, Loading, Notice, PageHeader, TableWrap } from '../ui/components';
import { employeeName, useDirectory, type Directory } from './data';

// Members are identified by their linked employee record; e-mail addresses are
// not exposed by the backend contracts and are never shown here.
export function MembersPage() {
  const tenant = useCurrentTenant();
  const directory = useDirectory();
  const [status, setStatus] = useState<string | null>(null);
  const [editing, setEditing] = useState<Membership | null>(null);
  const [inviting, setInviting] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const owner = tenant.role === 'OWNER';
  const self = tenant.current.membership.id;
  const data = directory.data;
  const describe = (m: Membership) => employeeName(data, m.id) ?? 'Persona sin ficha de empleado';

  const refresh = (message: string) => { setStatus(message); void directory.reload(); void tenant.reload(); };
  return (
    <>
      <PageHeader title="Personas y roles">
        <p>Cuentas con acceso a la organización. {owner ? 'Como propietario gestionas administradores y empleados.' : 'Como administrador gestionas cuentas de empleado; los administradores los gestiona la persona propietaria.'}</p>
      </PageHeader>
      <div className="button-row">
        <button type="button" className="btn btn-primary" onClick={() => { setStatus(null); setInviting(true); }}>Invitar a una persona</button>
        {owner && <button type="button" className="btn btn-secondary" onClick={() => { setStatus(null); setTransferring(true); }}>Transferir la propiedad</button>}
      </div>
      <LiveRegion tone="success" message={status} />
      {directory.loading && <Loading />}
      {directory.error && <Notice tone="error" title={directory.error} />}
      {data && (data.memberships.length === 0 ? <EmptyState>No hay cuentas.</EmptyState> : (
        <TableWrap label="Cuentas de la organización">
          <table className="table">
            <caption className="visually-hidden">Cuentas de la organización</caption>
            <thead><tr><th scope="col">Persona</th><th scope="col">Rol</th><th scope="col">Acceso</th><th scope="col">Alta</th><th scope="col"><span className="visually-hidden">Acciones</span></th></tr></thead>
            <tbody>
              {data.memberships.map((m) => {
                const manageable = m.id !== self && m.role !== 'OWNER' && (owner || m.role === 'EMPLOYEE');
                return (
                  <tr key={m.id}>
                    <th scope="row">{describe(m)}{m.id === self ? ' (tú)' : ''}</th>
                    <td>{ROLE_LABEL[m.role]}</td>
                    <td>{m.active ? <Badge tone="success">Activo</Badge> : <Badge>Retirado</Badge>}</td>
                    <td>{formatDateTime(m.created_at, DEFAULT_ZONE)}</td>
                    <td>{manageable && <button type="button" className="btn btn-secondary btn-small" onClick={() => { setStatus(null); setEditing(m); }}>Gestionar<span className="visually-hidden"> {describe(m)}</span></button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableWrap>
      ))}
      {editing && <MembershipDialog membership={editing} label={describe(editing)} owner={owner} onClose={() => setEditing(null)}
        onSaved={(message) => { setEditing(null); refresh(message); }} />}
      {inviting && data && <InviteDialog owner={owner} directory={data} onClose={() => setInviting(false)} />}
      {transferring && data && <TransferDialog candidates={data.memberships.filter((m) => m.active && m.id !== self)} describe={describe}
        onClose={() => setTransferring(false)} onDone={(message) => { setTransferring(false); refresh(message); }} />}
    </>
  );
}

function MembershipDialog({ membership, label, owner, onClose, onSaved }: {
  membership: Membership; label: string; owner: boolean; onClose: () => void; onSaved: (message: string) => void;
}) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const role = (owner ? String(form.get('role')) : 'EMPLOYEE') as Role;
    const active = form.get('access') === 'active';
    const args = { p_organization_id: tenant.current.organization.id, p_membership_id: membership.id, p_expected_version: membership.version, p_role: role, p_active: active };
    const key = JSON.stringify(args);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'manage_membership', { ...args, p_request_id: requestId });
      onSaved(active ? `Cambios guardados para ${label}.` : `Acceso retirado a ${label}. Su historial se conserva.`);
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open title={`Gestionar acceso: ${label}`} onClose={onClose}>
      <form noValidate onSubmit={submit}>
        {owner && (
          <Field label="Rol">
            {(p) => (
              <select {...p} name="role" defaultValue={membership.role}>
                <option value="EMPLOYEE">{ROLE_LABEL.EMPLOYEE}</option>
                <option value="ADMIN">{ROLE_LABEL.ADMIN}</option>
              </select>
            )}
          </Field>
        )}
        <fieldset className="fieldset">
          <legend>Acceso a la organización</legend>
          <label className="radio"><input type="radio" name="access" value="active" defaultChecked={membership.active} /> Activo</label>
          <label className="radio"><input type="radio" name="access" value="revoked" defaultChecked={!membership.active} /> Retirado (no borra registros ni historial)</label>
        </fieldset>
        <p className="hint">Retirar el acceso surte efecto inmediato en el servidor, incluso con sesiones abiertas.</p>
        <LiveRegion tone="error" message={error} />
        <div className="button-row">
          <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Guardando…' : 'Guardar'}</button>
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Dialog>
  );
}

// The invitation token is generated here; only its SHA-256 reaches the server.
// The resulting code is shown once for out-of-band delivery and then discarded.
function InviteDialog({ owner, directory, onClose }: { owner: boolean; directory: Directory; onClose: () => void }) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const org = tenant.current.organization.id;
  const [code, setCode] = useState<string | null>(null);
  const [role, setRole] = useState<Role>('EMPLOYEE');
  const availableEmployees = directory.employees.filter((e) => e.active && !e.membership_id);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const selectedRole = owner ? role : 'EMPLOYEE';
    const employeeId = selectedRole === 'EMPLOYEE' ? String(form.get('employee') ?? '') : '';
    if (employeeId && !availableEmployees.some((employee) => employee.id === employeeId)) {
      setError('La ficha seleccionada ya no está disponible. Actualiza la lista.'); return;
    }
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 254) { setError('Escribe un correo electrónico válido.'); return; }
    setPending(true);
    setError(null);
    try {
      const token = randomHex(32);
      const requestId = newRequestId();
      const tokenHash = await sha256Hex(token);
      if (employeeId) {
        await rpc(client, 'create_employee_invitation', {
          p_organization_id: org, p_request_id: requestId, p_employee_id: employeeId,
          p_email: email, p_token_hash: tokenHash,
        });
      } else {
        await rpc(client, 'create_invitation', {
          p_organization_id: org, p_request_id: requestId, p_email: email, p_role: selectedRole, p_token_hash: tokenHash,
        });
      }
      setCode(encodeInvitation(org, token));
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open title="Invitar a una persona" onClose={() => { setCode(null); onClose(); }}>
      {code ? (
        <>
          <p>Entrega este código a la persona invitada por un canal seguro. Caduca en 24 horas, sirve una sola vez y solo funciona con una cuenta verificada con ese correo.</p>
          <p className="secret-value secret-code">{code}</p>
          <p className="hint">No se volverá a mostrar. Si se pierde, crea otra invitación.</p>
          <button type="button" className="btn btn-primary" onClick={() => { setCode(null); onClose(); }}>Cerrar</button>
        </>
      ) : (
        <form noValidate onSubmit={submit}>
          <Field label="Correo electrónico de la persona" hint="Debe coincidir con el de su cuenta verificada. No se envía ningún correo.">
            {(p) => <input {...p} name="email" type="email" autoComplete="off" />}
          </Field>
          {owner ? (
            <Field label="Rol">
              {(p) => (
                <select {...p} name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
                  <option value="EMPLOYEE">{ROLE_LABEL.EMPLOYEE}</option>
                  <option value="ADMIN">{ROLE_LABEL.ADMIN}</option>
                </select>
              )}
            </Field>
          ) : <p>Rol: {ROLE_LABEL.EMPLOYEE}</p>}
          {(!owner || role === 'EMPLOYEE') && (
            <Field label="Vincular a ficha de empleado" hint="Al aceptar la invitación con el correo verificado, la cuenta se vinculará automáticamente a la ficha elegida.">
              {(p) => (
                <select {...p} name="employee" defaultValue="">
                  <option value="">Sin vincular (invitación genérica)</option>
                  {availableEmployees.map((employee) => (
                    <option key={employee.id} value={employee.id}>{employee.display_name} · {employee.code}</option>
                  ))}
                </select>
              )}
            </Field>
          )}
          <LiveRegion tone="error" message={error} />
          <div className="button-row">
            <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Creando…' : 'Crear invitación'}</button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function TransferDialog({ candidates, describe, onClose, onDone }: {
  candidates: Membership[]; describe: (m: Membership) => string; onClose: () => void; onDone: (message: string) => void;
}) {
  const { client } = useServices();
  const tenant = useCurrentTenant();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const attempt = useRef<{ key: string; requestId: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const target = candidates.find((m) => m.id === String(new FormData(event.currentTarget).get('target')));
    if (!target) { setError('Elige a la nueva persona propietaria.'); return; }
    if (!confirmed) { setError('Confirma que entiendes que pasarás a ser administrador.'); return; }
    const args = { p_organization_id: tenant.current.organization.id, p_new_owner_membership_id: target.id, p_expected_version: target.version };
    const key = JSON.stringify(args);
    if (attempt.current?.key !== key) attempt.current = { key, requestId: newRequestId() };
    const requestId = attempt.current.requestId;
    setPending(true);
    setError(null);
    try {
      await rpc(client, 'transfer_ownership', { ...args, p_request_id: requestId });
      onDone(`La propiedad se ha transferido a ${describe(target)}. Ahora eres administrador.`);
    } catch (failure) {
      tenant.handleError(failure);
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog open title="Transferir la propiedad" onClose={onClose}>
      {candidates.length === 0 ? (
        <><p>No hay otras cuentas activas a las que transferir.</p><button type="button" className="btn btn-secondary" onClick={onClose}>Cerrar</button></>
      ) : (
        <form noValidate onSubmit={submit}>
          <Field label="Nueva persona propietaria">
            {(p) => (
              <select {...p} name="target">
                {candidates.map((m) => <option key={m.id} value={m.id}>{describe(m)} ({ROLE_LABEL[m.role]})</option>)}
              </select>
            )}
          </Field>
          <label className="checkbox"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Entiendo que pasaré a ser administrador y no podré deshacerlo por mi cuenta.</label>
          <LiveRegion tone="error" message={error} />
          <div className="button-row">
            <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? 'Transfiriendo…' : 'Transferir'}</button>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancelar</button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

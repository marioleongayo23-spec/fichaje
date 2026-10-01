import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { addMember, assignPolicy, clock, createAccount, createEmployee, createPolicy, rpc, scenario, sql, stack } from './support/backend';
import { go, login } from './support/ui';

test.use({ serviceWorkers: 'block' });

async function sessionToken(page: Page): Promise<string> {
  return page.evaluate(() => JSON.parse(localStorage.getItem('fichaje-auth') ?? '{}').access_token as string);
}

test('tenant isolation: only the selected tenant is visible and cross-tenant calls are denied', async ({ page }) => {
  const a = await scenario();
  const b = await scenario();
  await login(page, a.owner);
  await expect(page.getByRole('banner')).toContainText(a.name);
  await go(page, 'Empleados');
  await expect(page.getByRole('row')).toHaveCount(6);
  await expect(page.getByText(b.name)).toHaveCount(0);
  // The real browser session cannot read or mutate another tenant.
  const token = await sessionToken(page);
  const results = await page.evaluate(async ({ token, url, key, foreign, employee }) => {
    const headers = { apikey: key, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const rows = await (await fetch(`${url}/rest/v1/employees?select=id&organization_id=eq.${foreign}`, { headers })).json();
    const state = await fetch(`${url}/rest/v1/rpc/get_employee_state`, { method: 'POST', headers, body: JSON.stringify({ p_organization_id: foreign, p_employee_id: employee }) });
    const write = await fetch(`${url}/rest/v1/rpc/manage_employee`, { method: 'POST', headers, body: JSON.stringify({ p_organization_id: foreign,
      p_request_id: crypto.randomUUID(), p_employee_id: employee, p_expected_version: 1, p_code: 'X', p_display_name: 'X', p_membership_id: null, p_active: false }) });
    return { rows: rows.length, state: state.status, write: write.status };
  }, { token, url: 'http://127.0.0.1:54321', key: stack().publishable, foreign: b.org, employee: b.employee.employee! });
  expect(results).toEqual({ rows: 0, state: 403, write: 403 });
  expect(sql(`select display_name from public.employees where id='${b.employee.employee}';`)).toBe('Elena Empleada');
});

test('multi-tenant identity chooses explicitly and switching discards tenant state', async ({ page }) => {
  const a = await scenario();
  const b = await scenario();
  const multi = await addMember(a.org, a.owner, 'EMPLOYEE');
  const employee = await createEmployee(a.org, a.owner, { membership: multi.membership, name: 'Mar Multiempresa' });
  await assignPolicy(a.org, a.owner, employee.id, a.policy);
  await addMember(b.org, b.owner, 'ADMIN', multi);
  await login(page, multi);
  await expect(page.getByRole('heading', { name: 'Elige organización' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(a.name) }).click();
  await expect(page.getByRole('banner')).toContainText(a.name);
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name: 'Empleados' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Cambiar organización' }).click();
  await page.getByRole('button', { name: new RegExp(b.name) }).click();
  await expect(page.getByRole('banner')).toContainText(b.name);
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);
  await expect(page.getByText('Mar Multiempresa')).toHaveCount(0);
  await expect(page.getByRole('row').filter({ hasText: 'Elena Empleada' })).toHaveCount(1);
  await expect(page.getByRole('row')).toHaveCount(6); // tenant B only
  await page.getByRole('button', { name: 'Cambiar organización' }).click();
  await page.getByRole('button', { name: new RegExp(a.name) }).click();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);
  await expect(page.locator('.state-value')).toHaveText('Trabajando');
});

test('employee management: no-email employee, edit, policy, deactivate; members and roles', async ({ page }) => {
  const s = await scenario();
  await login(page, s.owner);
  await go(page, 'Empleados');
  await page.getByRole('button', { name: 'Nuevo empleado' }).click();
  const create = page.getByRole('dialog', { name: 'Nuevo empleado' });
  await create.getByRole('button', { name: 'Guardar' }).click();
  await expect(create.getByText('El código es obligatorio')).toBeVisible();
  await create.getByLabel('Código de empleado').fill('K-100');
  await create.getByLabel('Nombre visible').fill('Nuevo Sin Correo');
  await expect(create.getByLabel('Cuenta vinculada')).toHaveValue('');
  await create.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Empleado «Nuevo Sin Correo» creado' })).toBeVisible();
  const id = sql(`select id from public.employees where organization_id='${s.org}' and code='K-100' and membership_id is null;`);
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: 'Ver ficha de Nuevo Sin Correo' }).click();
  await expect(page.getByRole('heading', { name: 'Ficha de Nuevo Sin Correo' })).toBeVisible();
  await expect(page.getByText('Sin horario asignado')).toBeVisible();
  await page.getByRole('button', { name: 'Asignar horario' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'asignado desde ahora' })).toBeVisible();
  expect(sql(`select count(*) from public.employee_policy_assignments where employee_id='${id}';`)).toBe('1');
  await page.getByRole('button', { name: 'Editar datos' }).click();
  const edit = page.getByRole('dialog', { name: 'Editar Nuevo Sin Correo' });
  await edit.getByLabel('Nombre visible').fill('Nora Sin Correo');
  await edit.getByLabel('Activo (puede fichar)').uncheck();
  await edit.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Datos de «Nora Sin Correo» guardados' })).toBeVisible();
  expect(sql(`select display_name||':'||active||':'||version from public.employees where id='${id}';`)).toBe('Nora Sin Correo:false:2');

  // Members: invitation code shown once, role change and access revocation.
  await go(page, 'Personas y roles');
  await page.getByRole('button', { name: 'Invitar a una persona' }).click();
  const invite = page.getByRole('dialog', { name: 'Invitar a una persona' });
  const invited = await createAccount('invited');
  await invite.getByLabel('Correo electrónico de la persona').fill(invited.email);
  await invite.getByRole('button', { name: 'Crear invitación' }).click();
  const code = (await invite.locator('.secret-code').textContent())!.trim();
  await invite.getByRole('button', { name: 'Cerrar' }).click();
  const [org, token] = code.split('.');
  expect(org).toBe(s.org);
  expect((await rpc('accept_invitation', invited.token, { p_organization_id: org, p_request_id: randomUUID(), p_token: token })).status).toBe(200);
  await page.getByRole('button', { name: 'Gestionar Elena Empleada' }).click();
  const manage = page.getByRole('dialog', { name: 'Gestionar acceso: Elena Empleada' });
  await manage.getByLabel('Rol').selectOption('ADMIN');
  await manage.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cambios guardados' })).toBeVisible();
  expect(sql(`select role from public.memberships where id='${s.employee.membership}';`)).toBe('ADMIN');
  await page.getByRole('button', { name: 'Gestionar Elena Empleada' }).click();
  await manage.getByLabel('Retirado (no borra registros ni historial)').check();
  await manage.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Acceso retirado' })).toBeVisible();
  expect(sql(`select active from public.memberships where id='${s.employee.membership}';`)).toBe('f');
});

test('an ADMIN manages only EMPLOYEE accounts; server refusals are shown plainly', async ({ page }) => {
  const s = await scenario();
  await login(page, s.admin);
  await go(page, 'Personas y roles');
  await expect(page.getByRole('button', { name: /Gestionar Alba Administradora/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Transferir la propiedad' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Gestionar Elena Empleada' }).click();
  await expect(page.getByRole('dialog').getByLabel('Rol')).toHaveCount(0);
});

test('correction inbox: independent approval, self-involvement, stale request and server refusal', async ({ page }) => {
  const s = await scenario();
  const e = s.employee;
  const entry = await clock(s.org, e, e.employee!, 'CLOCK_IN', 0);
  await clock(s.org, e, e.employee!, 'CLOCK_OUT', 1);
  const submit = async (user: typeof e, employeeId: string, eventId: string, version: number, reason: string, at: string) => rpc('submit_correction', user.token, {
    p_organization_id: s.org, p_request_id: randomUUID(), p_employee_id: employeeId, p_base_version: version, p_reason: reason,
    p_operations: [{ operation: 'REPLACE', target_event_id: eventId, session_id: sql(`select session_id from public.time_events where id='${eventId}';`),
      event_type: 'CLOCK_IN', effective_at: at, timezone: 'Europe/Madrid', ordinal: 1 }] });
  const earlier = new Date(new Date(entry.server_at).getTime() - 1800_000).toISOString();
  expect((await submit(e, e.employee!, entry.event_id, 2, 'Llegué antes', earlier)).status).toBe(200);
  expect((await submit(s.admin, e.employee!, entry.event_id, 2, 'Propuesta del gestor', earlier)).status).toBe(200);

  await login(page, s.admin);
  await go(page, 'Solicitudes de corrección');
  const own = page.locator('.card').filter({ hasText: 'Propuesta del gestor' });
  await expect(own).toContainText('No puedes decidir esta solicitud');
  await expect(own.getByRole('button', { name: /Aprobar/ })).toHaveCount(0);
  const card = page.locator('.card').filter({ hasText: 'Llegué antes' });
  await expect(card).toContainText('Elena Empleada');
  await expect(card).toContainText('la propia persona');
  await expect(card).toContainText('Cambiar entrada del');
  await card.getByRole('button', { name: /Aprobar/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Aprobar corrección' });
  await dialog.getByRole('button', { name: 'Confirmar aprobación' }).click();
  await expect(dialog.getByText('El motivo es obligatorio.')).toBeVisible();
  await dialog.getByLabel('Motivo de la decisión (obligatorio)').fill('Comprobado con el parte');
  await dialog.getByRole('button', { name: 'Confirmar aprobación' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Corrección aprobada' })).toBeVisible();
  expect(sql(`select decision from public.correction_decisions where employee_id='${e.employee}';`)).toBe('APPROVE');
  // The other pending request was built on the old base version: now stale.
  await expect(page.locator('.card').filter({ hasText: 'Propuesta del gestor' })).toContainText('Solicitud obsoleta');

  // Server-side independence the UI cannot see: the admin once clocked for the
  // employee record (was_clock_actor). Unlinked, then asked to decide: refused.
  const x = s.admin.employee!;
  const own1 = await clock(s.org, s.admin, x, 'CLOCK_IN', 0);
  await clock(s.org, s.admin, x, 'CLOCK_OUT', 1);
  const version = Number(sql(`select version from public.employees where id='${x}';`));
  expect((await rpc('manage_employee', s.owner.token, { p_organization_id: s.org, p_request_id: randomUUID(), p_employee_id: x, p_expected_version: version,
    p_code: sql(`select code from public.employees where id='${x}';`), p_display_name: 'Ficha desvinculada', p_membership_id: null, p_active: true })).status).toBe(200);
  expect((await submit(s.owner, x, own1.event_id, 2, 'Ajuste de la ficha desvinculada', new Date(new Date(own1.server_at).getTime() - 600_000).toISOString())).status).toBe(200);
  await page.reload();
  const refused = page.locator('.card').filter({ hasText: 'Ajuste de la ficha desvinculada' });
  await refused.getByRole('button', { name: /Aprobar/ }).click();
  const decide = page.getByRole('dialog', { name: 'Aprobar corrección' });
  await decide.getByLabel('Motivo de la decisión (obligatorio)').fill('Intento');
  await decide.getByRole('button', { name: 'Confirmar aprobación' }).click();
  await expect(decide.getByRole('alert')).toContainText('El servidor no te permite decidir esta solicitud');
  expect(sql(`select count(*) from public.correction_decisions where employee_id='${x}';`)).toBe('0');
});

test('hour classification of a closed month is declared and validated server-side', async ({ page }) => {
  const s = await scenario();
  const e = s.employee.employee!;
  // Synthetic historical fixture (privileged, like the H2 DST fixtures): a
  // policy and assignment valid since the previous month. RPCs cannot backdate.
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 10));
  const month = previous.toISOString().slice(0, 7);
  const policy = sql(`insert into public.work_policies(organization_id,version,timezone,break_counts_as_work,valid_from,created_by,created_at)
    values('${s.org}',99,'Europe/Madrid',false,'${month}-01T00:00:00+02:00','${s.owner.membership}',clock_timestamp()) returning id;`);
  sql(`insert into public.employee_policy_assignments(organization_id,employee_id,policy_id,effective_from,created_by,created_at)
    values('${s.org}','${e}','${policy}','${month}-01T00:00:00+02:00','${s.owner.membership}',clock_timestamp());`);
  const session = randomUUID();
  const add = (type: string, time: string, ordinal: number) => ({ operation: 'ADD', session_id: session, event_type: type,
    effective_at: `${month}-10T${time}:00+02:00`, timezone: 'Europe/Madrid', ordinal });
  const submitted = await rpc('submit_correction', s.owner.token, { p_organization_id: s.org, p_request_id: randomUUID(), p_employee_id: e,
    p_base_version: 0, p_reason: 'Jornada del mes anterior', p_operations: [add('CLOCK_IN', '09:00', 1), add('CLOCK_OUT', '17:30', 2)] });
  expect(submitted.status).toBe(200);
  expect((await rpc('decide_correction', s.admin.token, { p_organization_id: s.org, p_request_id: randomUUID(),
    p_correction_request_id: submitted.data.correction_request_id, p_decision: 'APPROVE', p_reason: 'Parte firmado' })).status).toBe(200);

  await login(page, s.admin2);
  await go(page, 'Clasificación de horas');
  await page.getByLabel('Empleado').selectOption(e);
  await page.getByLabel('Mes (cerrado)').fill(month);
  await expect(page.getByText('Tiempo computable del mes')).toContainText('8 h 30 min');
  await page.getByRole('group', { name: 'Horas extraordinarias' }).getByLabel('Horas').fill('1');
  await expect(page.getByText('Horas ordinarias (resto)')).toContainText('7 h 30 min');
  await page.getByLabel('Motivo (obligatorio)').fill('Refuerzo autorizado');
  await page.getByRole('button', { name: 'Registrar clasificación' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Clasificación registrada' })).toBeVisible();
  expect(sql(`select regular_seconds||':'||complementary_seconds||':'||overtime_seconds from public.hour_classifications where employee_id='${e}';`)).toBe('27000:0:3600');
  await expect(page.getByText('(vigente)')).toBeVisible();
});

test('organization export with signed download and controlled delivery receipt', async ({ page }, testInfo) => {
  const s = await scenario();
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_OUT', 1);
  await login(page, s.owner);
  await go(page, 'Exportaciones');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await page.getByLabel('Desde').fill(today.slice(0, 8) + '01');
  await page.getByLabel('Hasta').fill(today);
  await page.getByRole('button', { name: 'Solicitar exportación' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Paquete preparado' })).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar' }).click();
  const file = testInfo.outputPath('org-export.zip');
  await (await download).saveAs(file);
  expect(readFileSync(file).subarray(0, 2).toString()).toBe('PK');
  rmSync(file);
  await page.getByRole('button', { name: 'Registrar entrega controlada' }).click();
  const dialog = page.getByRole('dialog', { name: 'Registrar entrega controlada' });
  await dialog.getByLabel('Destinatario').selectOption('INSPECTION');
  await dialog.getByLabel('Referencia del recibo').fill('ITSS-2026-001');
  await dialog.getByLabel('Finalidad').fill('Requerimiento de información');
  await dialog.getByRole('button', { name: 'Registrar entrega' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Entrega registrada y auditada' })).toBeVisible();
  expect(sql(`select recipient_kind from private.evidence_deliveries where organization_id='${s.org}' and receipt_ref='ITSS-2026-001';`)).toBe('INSPECTION');
});

test('policies are versioned and never edited', async ({ page }) => {
  const s = await scenario();
  await createPolicy(s.org, s.owner, 'Atlantic/Canary', true);
  await login(page, s.admin);
  await go(page, 'Horarios');
  await expect(page.getByRole('row')).toHaveCount(3);
  await page.getByLabel('Zona horaria').selectOption('Atlantic/Canary');
  await page.getByRole('radio', { name: 'Sí computan' }).check();
  await page.getByRole('button', { name: 'Crear horario' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Horario v3 creado' })).toBeVisible();
  expect(sql(`select timezone||':'||break_counts_as_work from public.work_policies where organization_id='${s.org}' and version=3;`)).toBe('Atlantic/Canary:true');
});

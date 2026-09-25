import { readFileSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { addMember, clock, createEmployee, eventCount, rpc, runExportWorker, scenario, sql, stateVersion } from './support/backend';
import { browserPersistence, go, login } from './support/ui';

// Real Auth, PostgREST RPCs and PostgreSQL. page.route is used only to lose or
// fake transport responses; every committed effect is checked in the database.
test.use({ serviceWorkers: 'block' });

const madrid = (iso: string, seconds = true) => new Intl.DateTimeFormat('es-ES', {
  timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hourCycle: 'h23',
}).format(new Date(iso));

async function press(page: Page, action: string, done: string) {
  const response = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/record_time_event'));
  await page.getByRole('button', { name: action, exact: true }).click();
  const receipt = await (await response).json();
  await expect(page.getByRole('heading', { name: done })).toBeVisible();
  await expect(page.locator('.receipt')).toContainText(madrid(receipt.server_at));
  return receipt;
}

test('full cycle with confirmation only after the server ACK', async ({ page }) => {
  const s = await scenario();
  await login(page, s.employee);
  await expect(page.getByRole('heading', { name: 'Fichar' })).toBeVisible();
  await expect(page.locator('.state-value')).toHaveText('Fuera de jornada');
  // Only actions valid for OUT are offered; the server remains the authority.
  await expect(page.getByRole('button', { name: 'Entrada', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /pausa|Salida/ })).toHaveCount(0);

  // Hold the real response: nothing may be confirmed while the ACK is pending.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/rest/v1/rpc/record_time_event', async (route) => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  const first = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/record_time_event'));
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Espera la confirmación del servidor' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);
  await expect(page.locator('.state-value')).toHaveText('Fuera de jornada');
  await expect.poll(() => eventCount(s.org, s.employee.employee!)).toBe(1); // committed, not yet acknowledged
  release();
  const receipt = await (await first).json();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  await expect(page.locator('.receipt')).toContainText(madrid(receipt.server_at));
  await expect(page.locator('.receipt')).toContainText('Trabajando');
  await expect(page.locator('.state-value')).toHaveText('Trabajando');

  await press(page, 'Iniciar pausa', 'Pausa iniciada');
  await expect(page.locator('.state-value')).toHaveText('En pausa');
  await press(page, 'Finalizar pausa', 'Pausa finalizada');
  await press(page, 'Salida', 'Salida registrada');
  await expect(page.locator('.state-value')).toHaveText('Fuera de jornada');
  expect(sql(`select string_agg(event_type::text,',' order by sequence) from public.time_events where employee_id='${s.employee.employee}';`))
    .toBe('CLOCK_IN,BREAK_START,BREAK_END,CLOCK_OUT');

  // Own evidence: originals, sources and informative totals.
  await go(page, 'Mi registro');
  const session = page.locator('article.session');
  await expect(session).toHaveCount(1);
  await expect(session.getByRole('row')).toHaveCount(5);
  await expect(session).toContainText('Completa');
  await expect(session).toContainText('Fichaje original (web)');
  await expect(session).toContainText('Duración bruta');
  // Labour history is never persisted in the browser.
  const stored = JSON.stringify(await browserPersistence(page));
  expect(stored.includes('server_at') || stored.includes('Elena Empleada') || stored.includes(receipt.event_id)).toBe(false);
});

test('clock out directly from pause and double click create a single event each', async ({ page }) => {
  const s = await scenario();
  await login(page, s.employee);
  let calls = 0;
  page.on('request', (r) => { if (r.url().includes('/rpc/record_time_event')) calls++; });
  await page.getByRole('button', { name: 'Entrada', exact: true }).dblclick();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  await page.waitForTimeout(500);
  expect(calls).toBe(1);
  expect(eventCount(s.org, s.employee.employee!)).toBe(1);
  await press(page, 'Iniciar pausa', 'Pausa iniciada');
  await press(page, 'Salida', 'Salida registrada');
  // Exit from PAUSED closes the pause at the same instant: no synthetic BREAK_END.
  expect(sql(`select string_agg(event_type::text,',' order by sequence) from public.time_events where employee_id='${s.employee.employee}';`))
    .toBe('CLOCK_IN,BREAK_START,CLOCK_OUT');
});

test('lost ACK shows an unknown result and the safe retry never duplicates', async ({ page }) => {
  const s = await scenario();
  await login(page, s.employee);
  await page.route('**/rest/v1/rpc/record_time_event', async (route) => {
    await route.fetch(); // the real server commits
    await route.abort('connectionreset'); // ...but the browser never receives the ACK
  }, { times: 1 });
  let bodies: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rpc/record_time_event')) bodies.push(r.postData() ?? ''); });
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Resultado desconocido' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);
  expect(eventCount(s.org, s.employee.employee!)).toBe(1);
  await expect(page.getByRole('button', { name: 'Comprobar resultado' })).toBeFocused();
  await page.getByRole('button', { name: 'Comprobar resultado' }).click();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  expect(eventCount(s.org, s.employee.employee!)).toBe(1);
  const serverAt = sql(`select to_json(server_at) from public.time_events where employee_id='${s.employee.employee}';`).replace(/"/g, '');
  await expect(page.locator('.receipt')).toContainText(madrid(serverAt));
  // Both attempts carried the same request_id (server-side idempotency).
  expect(new Set(bodies.map((b) => JSON.parse(b).p_request_id)).size).toBe(1);

  // Faked 500 before reaching the server: unknown outcome, then one real event.
  bodies = [];
  await page.route('**/rest/v1/rpc/record_time_event', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"message":"boom"}' }), { times: 1 });
  await page.getByRole('button', { name: 'Iniciar pausa' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Resultado desconocido' })).toBeVisible();
  await expect(page.getByText('boom')).toHaveCount(0);
  expect(eventCount(s.org, s.employee.employee!)).toBe(1);
  await page.getByRole('button', { name: 'Comprobar resultado' }).click();
  await expect(page.getByRole('heading', { name: 'Pausa iniciada' })).toBeVisible();
  expect(eventCount(s.org, s.employee.employee!)).toBe(2);
});

test('server rejections are explained and nothing is confirmed', async ({ page }) => {
  const s = await scenario();
  // Employee without an assigned policy: POLICY_REQUIRED from the real RPC.
  const member = await addMember(s.org, s.owner, 'EMPLOYEE');
  await createEmployee(s.org, s.owner, { membership: member.membership, name: 'Sin Horario' });
  await login(page, member);
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('No hay un horario asignado');
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);
  await expect(page.locator('.state-value')).toHaveText('Fuera de jornada');

  // State changed on another device: VERSION_CONFLICT, UI refreshes from server.
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await login(page, s.employee);
  await expect(page.locator('.state-value')).toHaveText('Fuera de jornada');
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Los datos han cambiado');
  await expect(page.locator('.state-value')).toHaveText('Trabajando');
  expect(eventCount(s.org, s.employee.employee!)).toBe(1);
});

test('revoked membership is reflected immediately and cannot clock', async ({ page }) => {
  const s = await scenario();
  await login(page, s.employee);
  await expect(page.getByRole('button', { name: 'Entrada', exact: true })).toBeVisible();
  const version = Number(sql(`select version from public.memberships where id='${s.employee.membership}';`));
  const { status } = await rpc('manage_membership', s.owner.token, { p_organization_id: s.org, p_request_id: randomUUID(),
    p_membership_id: s.employee.membership, p_expected_version: version, p_role: 'EMPLOYEE', p_active: false });
  expect(status).toBe(200);
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No tienes acceso a ninguna organización' })).toBeVisible();
  await expect(page.getByText('Tu acceso a la organización seleccionada ha cambiado')).toBeVisible();
  await expect(page.getByText(s.name)).toHaveCount(0);
  expect(eventCount(s.org, s.employee.employee!)).toBe(0);
});

test('correction request with review, independent approval and own export', async ({ page }, testInfo) => {
  const s = await scenario();
  const entry = await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_OUT', 1);
  await login(page, s.employee);
  await go(page, 'Mi registro');
  await page.getByRole('button', { name: 'Solicitar corrección de esta jornada' }).click();
  const dialog = page.getByRole('dialog', { name: 'Solicitar corrección de la jornada' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: /^Entrada a las/ }).check();
  // One hour earlier, expressed in the session's local time.
  const earlier = new Date(new Date(entry.server_at).getTime() - 3600_000);
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(earlier);
  await dialog.getByLabel('Fecha').fill(local);
  await dialog.getByLabel('Hora', { exact: true }).fill(madrid(earlier.toISOString(), false));
  await dialog.getByRole('button', { name: 'Revisar solicitud' }).click();
  await expect(dialog.getByText('El motivo es obligatorio.')).toBeVisible();
  await dialog.getByLabel('Motivo (obligatorio)').fill('Olvidé fichar al llegar');
  await dialog.getByRole('button', { name: 'Revisar solicitud' }).click();
  await expect(dialog.getByText(/Cambiar entrada del/)).toBeVisible();
  expect(Number(sql(`select count(*) from public.correction_requests where employee_id='${s.employee.employee}';`))).toBe(0);
  await dialog.getByRole('button', { name: 'Enviar solicitud' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Solicitud de corrección enviada' })).toBeVisible();
  const proposal = JSON.parse(sql(`select proposal from public.correction_requests where employee_id='${s.employee.employee}';`));
  expect(proposal).toEqual([expect.objectContaining({ operation: 'REPLACE', target_event_id: entry.event_id, event_type: 'CLOCK_IN', timezone: 'Europe/Madrid' })]);
  await go(page, 'Mis correcciones');
  await expect(page.locator('.card')).toContainText('Pendiente');

  // Independent manager approves through the real RPC; originals stay intact.
  const request = sql(`select id from public.correction_requests where employee_id='${s.employee.employee}';`);
  expect((await rpc('decide_correction', s.admin2.token, { p_organization_id: s.org, p_request_id: randomUUID(),
    p_correction_request_id: request, p_decision: 'APPROVE', p_reason: 'Verificado' })).status).toBe(200);
  await page.reload();
  await expect(page.locator('.card')).toContainText('Aprobada');
  await go(page, 'Mi registro');
  await expect(page.locator('article.session')).toContainText('Corrección aprobada (original:');
  await page.getByText('Registros originales y correcciones').click();
  await expect(page.locator('article.session')).toContainText('Sustituido por una corrección');
  expect(sql(`select server_at='${entry.server_at}'::timestamptz from public.time_events where id='${entry.event_id}';`)).toBe('t');

  // Own export: request, generate (offline worker), then fresh signed link.
  await go(page, 'Exportar mi registro');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await page.getByLabel('Desde').fill(today.slice(0, 8) + '01');
  await page.getByLabel('Hasta').fill(today);
  await page.getByRole('button', { name: 'Solicitar exportación' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Exportación solicitada' })).toBeVisible();
  // Not generated yet: the signer refuses and the UI says so without a link.
  await page.getByRole('button', { name: 'Descargar' }).click();
  await expect(page.getByRole('alert')).toContainText('todavía no está listo');
  runExportWorker();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Descargar' }).click();
  const file = testInfo.outputPath('export.zip');
  await (await download).saveAs(file);
  expect(readFileSync(file).subarray(0, 2).toString()).toBe('PK');
  rmSync(file);
  const stored = JSON.stringify(await browserPersistence(page));
  expect(stored.includes('/object/sign/') || stored.includes('token=')).toBe(false);
  expect(stateVersion(s.org, s.employee.employee!)).toBe(3);
});

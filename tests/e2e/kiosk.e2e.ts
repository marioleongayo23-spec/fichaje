import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { audit, structure, targets } from './support/a11y';
import { eventCount, scenario, signIn, sql } from './support/backend';
import { GENERIC_FAILURE, identify, issuePin, openKiosk, provisionKiosk } from './support/kiosk';
import { RUN_DIR, serviceLogs } from './support/services';
import { browserPersistence, expectAbsent, go, login } from './support/ui';

test.use({ serviceWorkers: 'block' });

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const actions = (kiosk: Page) => kiosk.locator('.clock-actions button');
const state = (org: string, employee: string) =>
  sql(`select state||'/'||version from private.employee_state where organization_id='${org}' and employee_id='${employee}';`);

test('kiosk clocks an employee without e-mail by code+PIN, offering only legal actions after the ACK', async ({ page, browser }, testInfo) => {
  const s = await scenario();
  await login(page, s.owner);
  const { code, setup } = await provisionKiosk(page, 'Entrada almacén');
  expect(setup.organizationId).toBe(s.org);
  expect(sql(`select active from private.kiosk_devices where id='${setup.deviceId}';`)).toBe('t');
  const pin = await issuePin(page, 'Kiko Sin Correo');
  expectAbsent(await page.content(), [pin], 'manager DOM after closing the PIN dialog');
  const { context, kiosk, consoleLines } = await openKiosk(browser, testInfo, code);

  // No directory, management or export surface on the shared device.
  for (const name of ['Kiko Sin Correo', 'Elena Empleada', 'Olga Propietaria']) await expect(kiosk.getByText(name)).toHaveCount(0);
  await expect(kiosk.getByRole('link')).toHaveCount(0);
  await expect(kiosk.getByRole('navigation')).toHaveCount(0);
  await structure(kiosk, false);
  await targets(kiosk);
  await audit(kiosk, 'kiosk code step');

  // Wrong PIN and unknown code: the same generic answer, nothing recorded.
  const wrong = pin === '00000000' ? '11111111' : '00000000';
  await identify(kiosk, s.kiosk.code, wrong);
  await expect(kiosk.getByRole('alert')).toHaveText(GENERIC_FAILURE);
  await identify(kiosk, 'codigo-inexistente', pin);
  await expect(kiosk.getByRole('alert')).toHaveText(GENERIC_FAILURE);
  expect(eventCount(s.org, s.kiosk.id)).toBe(0);

  // OUT: the server offers only «Entrada»; confirmation waits for the real ACK.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await kiosk.route('**/gateway/kiosk/record', async (route) => { await gate; await route.continue(); });
  await kiosk.getByLabel('Código de empleado').fill(s.kiosk.code);
  await kiosk.getByRole('button', { name: 'Continuar' }).click();
  await audit(kiosk, 'kiosk PIN step');
  await kiosk.getByLabel('PIN (8 cifras)').fill(pin);
  await kiosk.getByRole('button', { name: 'Continuar' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Estado: Fuera de jornada' })).toBeVisible();
  await expect(actions(kiosk)).toHaveText(['Entrada']);
  await targets(kiosk);
  await audit(kiosk, 'kiosk choose step');
  await actions(kiosk).first().click();
  await expect(kiosk.getByRole('button', { name: 'Enviando…' })).toBeVisible();
  await expect(kiosk.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);
  release();
  await expect(kiosk.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  await kiosk.unroute('**/gateway/kiosk/record');
  await audit(kiosk, 'kiosk receipt');
  expect(sql(`select source||'/'||(actor_membership_id is null)||'/'||kiosk_device_id from public.time_events where employee_id='${s.kiosk.id}';`))
    .toBe(`KIOSK/true/${setup.deviceId}`);
  expect(state(s.org, s.kiosk.id)).toBe('WORKING/1');
  // The receipt clears itself (10 s) without interaction.
  await expect(kiosk.getByLabel('Código de empleado')).toBeVisible({ timeout: 11_000 });
  await expect(kiosk.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);

  // WORKING: pause or exit. PAUSED: end pause or exit.
  await identify(kiosk, s.kiosk.code, pin);
  await expect(kiosk.getByRole('heading', { name: 'Estado: Trabajando' })).toBeVisible();
  await expect(actions(kiosk)).toHaveText(['Iniciar pausa', 'Salida']);
  await kiosk.getByRole('button', { name: 'Iniciar pausa' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Pausa iniciada' })).toBeVisible();
  await kiosk.getByRole('button', { name: 'Terminar' }).click();
  await identify(kiosk, s.kiosk.code, pin);
  await expect(kiosk.getByRole('heading', { name: 'Estado: En pausa' })).toBeVisible();
  await expect(actions(kiosk)).toHaveText(['Finalizar pausa', 'Salida']);
  await kiosk.getByRole('button', { name: 'Salida' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Salida registrada' })).toBeVisible();
  expect(eventCount(s.org, s.kiosk.id)).toBe(3);
  expect(state(s.org, s.kiosk.id)).toBe('OUT/3');
  await kiosk.getByRole('button', { name: 'Terminar' }).click();

  // PIN and code never persist or reach the console; only the device identity is stored.
  const stored = await browserPersistence(kiosk);
  expect(Object.keys(stored.local).sort()).toEqual(['fichaje-kiosk-auth', 'fichaje-kiosk-device']);
  expect(stored.session).toEqual({});
  expect(stored.caches).toEqual([]);
  expectAbsent(JSON.stringify(stored), [pin, s.kiosk.code, setup.password, code], 'kiosk browser storage');
  expectAbsent(consoleLines.join('\n'), [pin, s.kiosk.code, setup.password, code], 'kiosk console');
  await expect(kiosk.locator('input')).toHaveCount(1);
  expect(await kiosk.getByLabel('Código de empleado').inputValue()).toBe('');
  await context.close();
});

test('kiosk: lost ACK and timeout recover once, double tap, expired and reused challenges, revocation, no leaks', { tag: '@desktop-only' }, async ({ page, browser }, testInfo) => {
  const s = await scenario();
  await login(page, s.owner);
  const { code, setup } = await provisionKiosk(page, 'Recepción');
  const pin = await issuePin(page, 'Kiko Sin Correo');
  const { context, kiosk, consoleLines } = await openKiosk(browser, testInfo, code);
  const sent: Record<string, unknown>[] = [];
  const challenges: string[] = [];
  kiosk.on('request', (request) => {
    if (request.url().endsWith('/gateway/kiosk/record')) sent.push(request.postDataJSON() as Record<string, unknown>);
  });
  kiosk.on('response', async (response) => {
    if (!response.url().endsWith('/gateway/kiosk/authenticate') || response.status() !== 200) return;
    const body = await response.json() as { challenges: { challenge: string }[] };
    challenges.push(...body.challenges.map((c) => c.challenge));
  });

  // Lost ACK: the gateway commits, the browser never sees the answer.
  await kiosk.route('**/gateway/kiosk/record', async (route) => { await route.fetch(); await route.abort('failed'); }, { times: 1 });
  await identify(kiosk, s.kiosk.code, pin);
  await kiosk.getByRole('button', { name: 'Entrada' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Resultado desconocido' })).toBeVisible();
  await expect(kiosk.getByRole('heading', { name: 'Entrada registrada' })).toHaveCount(0);
  expect(eventCount(s.org, s.kiosk.id)).toBe(1);
  await kiosk.getByRole('button', { name: 'Comprobar' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  expect(eventCount(s.org, s.kiosk.id)).toBe(1);
  expect(sent[1]).toEqual(sent[0]);

  // Timeout before the server: unknown, then the same tuple records exactly once.
  await kiosk.getByRole('button', { name: 'Terminar' }).click();
  await kiosk.route('**/gateway/kiosk/record', (route) => route.abort('timedout'), { times: 1 });
  await identify(kiosk, s.kiosk.code, pin);
  await kiosk.getByRole('button', { name: 'Iniciar pausa' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Resultado desconocido' })).toBeVisible();
  expect(eventCount(s.org, s.kiosk.id)).toBe(1);
  await kiosk.getByRole('button', { name: 'Comprobar' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Pausa iniciada' })).toBeVisible();
  expect(eventCount(s.org, s.kiosk.id)).toBe(2);

  // Double tap: one request, one event.
  await kiosk.getByRole('button', { name: 'Terminar' }).click();
  await identify(kiosk, s.kiosk.code, pin);
  const before = sent.length;
  await kiosk.getByRole('button', { name: 'Finalizar pausa' }).dblclick();
  await expect(kiosk.getByRole('heading', { name: 'Pausa finalizada' })).toBeVisible();
  expect(sent.length - before).toBe(1);
  expect(eventCount(s.org, s.kiosk.id)).toBe(3);

  // Reused challenge through the same-origin gateway path: the exact tuple only
  // recovers its receipt; a new request or a different action is refused.
  const token = await signIn(setup.email, setup.password);
  const post = async (body: Record<string, unknown>) => {
    const response = await fetch('http://127.0.0.1:4173/gateway/kiosk/record', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    return [response.status, await response.json()] as const;
  };
  const last = sent.at(-1)!;
  expect((await post(last))[0]).toBe(200);
  expect(await post({ ...last, request_id: randomUUID() })).toEqual([403, { error: 'AUTH_FAILED' }]);
  expect(await post({ ...last, action: 'CLOCK_OUT' })).toEqual([403, { error: 'AUTH_FAILED' }]);
  expect(await post({ ...last, employee_id: s.employee.employee })).toEqual([403, { error: 'AUTH_FAILED' }]);
  expect(eventCount(s.org, s.kiosk.id)).toBe(3);

  // Expired challenge (server TTL moved to the past): not recorded, back to identification.
  await kiosk.getByRole('button', { name: 'Terminar' }).click();
  await identify(kiosk, s.kiosk.code, pin);
  await expect(kiosk.getByRole('heading', { name: 'Estado: Trabajando' })).toBeVisible();
  sql(`update private.kiosk_challenges set created_at=statement_timestamp()-interval '62 seconds',expires_at=statement_timestamp()-interval '2 seconds' where device_id='${setup.deviceId}' and used_at is null;`);
  await kiosk.getByRole('button', { name: 'Salida' }).click();
  await expect(kiosk.getByRole('alert')).toContainText('No se ha registrado el fichaje');
  await expect(kiosk.getByLabel('Código de empleado')).toBeVisible();
  expect(eventCount(s.org, s.kiosk.id)).toBe(3);

  // Revocation: the correct PIN on the revoked device gets the same generic answer.
  await go(page, 'Kioscos');
  await page.getByRole('button', { name: `Revocar kiosco terminado en ${setup.deviceId.slice(-6)}` }).click();
  await page.getByRole('dialog', { name: 'Revocar kiosco' }).getByRole('button', { name: 'Revocar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kiosco revocado' })).toBeVisible();
  await identify(kiosk, s.kiosk.code, pin);
  await expect(kiosk.getByRole('alert')).toHaveText(GENERIC_FAILURE);
  expect(eventCount(s.org, s.kiosk.id)).toBe(3);
  await kiosk.getByText('Opciones del dispositivo').click();
  await kiosk.getByRole('button', { name: 'Retirar configuración de este dispositivo' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Configurar este dispositivo' })).toBeVisible();
  expect(Object.keys((await browserPersistence(kiosk)).local)).toEqual([]);

  // Synthetic PIN, device credential, device JWT and challenge secrets: absent
  // from both browsers' storage and caches, consoles, gateway/signer logs and artefacts.
  expect(challenges).toHaveLength(7); // 1 (OUT) + 2 + 2 + 2 offered challenges
  const secrets = [pin, setup.password, code, token, ...challenges];
  expectAbsent(JSON.stringify(await browserPersistence(page)), secrets, 'manager browser storage and caches');
  expectAbsent(JSON.stringify(await browserPersistence(kiosk)), secrets, 'kiosk browser storage and caches');
  expectAbsent(consoleLines.join('\n'), secrets, 'kiosk console');
  expectAbsent(serviceLogs(), secrets, 'gateway and signer logs');
  for (const file of [...filesUnder(testInfo.outputDir), ...filesUnder(RUN_DIR)]) {
    expectAbsent(readFileSync(file, 'latin1'), secrets, 'test artefacts');
  }
  await context.close();
});

test('identified kiosk screen clears in under 15 s without interaction', { tag: '@desktop-only' }, async ({ page, browser }, testInfo) => {
  const s = await scenario();
  await login(page, s.owner);
  const { code } = await provisionKiosk(page, 'Taller');
  const pin = await issuePin(page, 'Kiko Sin Correo');
  const { context, kiosk } = await openKiosk(browser, testInfo, code);
  await identify(kiosk, s.kiosk.code, pin);
  // Measured inside the page with fine polling: from the identified screen
  // appearing to the code entry being back, without any interaction.
  await kiosk.waitForFunction(() => document.querySelector('#kiosk-choose'), null, { polling: 20 });
  const shown = Date.now();
  await kiosk.waitForFunction(() => document.querySelector('#kiosk-code') && !document.querySelector('#kiosk-choose'), null, { polling: 50, timeout: 16_000 });
  const elapsed = Date.now() - shown;
  expect(elapsed).toBeGreaterThan(12_000);
  expect(elapsed).toBeLessThan(15_000);
  await expect(kiosk.getByText('Estado: Fuera de jornada')).toHaveCount(0);
  await expect(kiosk.getByRole('button', { name: 'Entrada' })).toHaveCount(0);
  expect(eventCount(s.org, s.kiosk.id)).toBe(0);
  await context.close();
});

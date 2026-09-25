import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type BrowserContextOptions, type Page } from '@playwright/test';
import { H4KioskGateway } from '../../src/kiosk/gateway';
import { parseDeviceSetup } from '../../src/lib/codes';
import { ApiError } from '../../src/lib/errors';
import { eventCount, scenario, signIn, sql, stateVersion } from './support/backend';
import { RUN_DIR, serviceLogs } from './support/services';
import { browserPersistence, expectAbsent, go, login } from './support/ui';

test.use({ serviceWorkers: 'block' });

async function provision(page: Page, name: string): Promise<string> {
  await go(page, 'Kioscos');
  await page.getByRole('button', { name: 'Preparar un kiosco' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preparar un kiosco' });
  await dialog.getByLabel('Nombre del kiosco').fill(name);
  await dialog.getByRole('button', { name: 'Preparar' }).click();
  const code = (await dialog.locator('.secret-code').textContent())!.trim();
  await dialog.getByRole('button', { name: 'He configurado el dispositivo; cerrar' }).click();
  await expect(dialog).toHaveCount(0);
  return code;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

test('provisioned kiosk device signs in, shows no directory and fails safe; revocation', async ({ page, browser }, testInfo) => {
  const s = await scenario();
  await login(page, s.owner);
  const code = await provision(page, 'Entrada almacén');
  const setup = parseDeviceSetup(code)!;
  expect(setup.organizationId).toBe(s.org);
  expect(sql(`select active from private.kiosk_devices where id='${setup.deviceId}';`)).toBe('t');
  await expect(page.getByRole('row').filter({ hasText: setup.deviceId.slice(-6) })).toContainText('Autorizado');

  // A separate browser context stands for the shared kiosk device.
  const device = await browser.newContext({ ...(testInfo.project.use as BrowserContextOptions), serviceWorkers: 'block' });
  const kiosk = await device.newPage();
  const consoleLines: string[] = [];
  kiosk.on('console', (message) => consoleLines.push(message.text()));
  await kiosk.goto('/kiosco');
  await kiosk.getByLabel('Código de configuración').fill('KIOSCO1.invalido');
  await kiosk.getByRole('button', { name: 'Configurar' }).click();
  await expect(kiosk.getByRole('alert')).toContainText('no es válido');
  await kiosk.getByLabel('Código de configuración').fill(code);
  await kiosk.getByRole('button', { name: 'Configurar' }).click();
  await expect(kiosk.getByText('El fichaje en este kiosco todavía no está disponible.')).toBeVisible();
  await expect(kiosk.getByText('No se ha registrado ni se registrará ningún fichaje desde aquí.')).toBeVisible();
  // No employee directory, no management/export navigation, no code/PIN inputs.
  for (const name of ['Kiko Sin Correo', 'Elena Empleada', 'Olga Propietaria']) await expect(kiosk.getByText(name)).toHaveCount(0);
  await expect(kiosk.getByRole('link')).toHaveCount(0);
  await expect(kiosk.getByRole('navigation')).toHaveCount(0);
  await expect(kiosk.locator('input')).toHaveCount(0);
  const stored = await browserPersistence(kiosk);
  expect(Object.keys(stored.local).sort()).toEqual(['fichaje-kiosk-auth', 'fichaje-kiosk-device']);
  expectAbsent(JSON.stringify(stored), [setup.password, code], 'kiosk device storage');
  expectAbsent(consoleLines.join('\n'), [setup.password, code], 'kiosk console');
  await kiosk.reload();
  await expect(kiosk.getByText('El fichaje en este kiosco todavía no está disponible.')).toBeVisible();

  // Manager revokes: effective immediately in the database.
  await page.getByRole('button', { name: `Revocar kiosco terminado en ${setup.deviceId.slice(-6)}` }).click();
  await page.getByRole('dialog', { name: 'Revocar kiosco' }).getByRole('button', { name: 'Revocar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kiosco revocado' })).toBeVisible();
  expect(sql(`select active from private.kiosk_devices where id='${setup.deviceId}';`)).toBe('f');
  await kiosk.getByText('Opciones del dispositivo').click();
  await kiosk.getByRole('button', { name: 'Retirar configuración de este dispositivo' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Configurar este dispositivo' })).toBeVisible();
  expect(Object.keys((await browserPersistence(kiosk)).local)).toEqual([]);
  await device.close();
});

test('PIN reset is shown once and the H4 gateway contract holds without leaks', { tag: '@desktop-only' }, async ({ page }, testInfo) => {
  const s = await scenario();
  const consoleLines: string[] = [];
  page.on('console', (message) => consoleLines.push(message.text()));
  await login(page, s.owner);
  const code = await provision(page, 'Recepción');
  const setup = parseDeviceSetup(code)!;
  await go(page, 'Empleados');
  await page.getByRole('button', { name: 'Ver ficha de Kiko Sin Correo' }).click();
  await page.getByRole('button', { name: 'Generar PIN de kiosco' }).click();
  const dialog = page.getByRole('dialog', { name: 'Generar PIN de kiosco' });
  await dialog.getByRole('button', { name: 'Generar PIN' }).click();
  const shown = page.getByRole('dialog', { name: 'PIN de kiosco generado' });
  const pin = (await shown.locator('.secret-value').textContent())!.replace(/\s/g, '');
  expect(/^\d{8}$/.test(pin)).toBe(true);
  await shown.getByRole('button', { name: 'He entregado el PIN; cerrar' }).click();
  await expect(shown).toHaveCount(0);
  expectAbsent(await page.content(), [pin], 'page DOM after closing');
  expect(sql(`select credential_version from private.kiosk_credentials where employee_id='${s.kiosk.id}';`)).toBe('1');

  // Real H4 gateway through the same-origin path the browser uses. The only
  // privileged step is reading expected_version via SQL: that is precisely the
  // contract gap documented as the H6 kiosk blocker.
  const token = await signIn(setup.email, setup.password);
  const gateway = new H4KioskGateway(`http://127.0.0.1:4173/gateway/kiosk`, setup, async () => token);
  const failure = async (promise: Promise<unknown>) => promise.then(() => 'ACCEPTED', (e) => e instanceof ApiError ? e.code : 'OTHER');
  const wrong = pin === '00000000' ? '11111111' : '00000000';
  expect(await failure(gateway.authenticate(s.kiosk.code, wrong, 'CLOCK_IN', 0, randomUUID()))).toBe('FORBIDDEN');
  expect(await failure(gateway.authenticate('codigo-inexistente', pin, 'CLOCK_IN', 0, randomUUID()))).toBe('FORBIDDEN');
  const version = stateVersion(s.org, s.kiosk.id);
  const requestId = randomUUID();
  const auth = await gateway.authenticate(s.kiosk.code, pin, 'CLOCK_IN', version, requestId);
  const challenge = { challenge: auth.challenge, requestId };
  const receipt = await gateway.record(s.kiosk.id, 'CLOCK_IN', version, challenge);
  expect(receipt.state).toBe('WORKING');
  expect(sql(`select source from public.time_events where employee_id='${s.kiosk.id}';`)).toBe('KIOSK');
  // Same tuple recovers the same receipt (lost ACK); a different action cannot reuse it.
  expect((await gateway.record(s.kiosk.id, 'CLOCK_IN', version, challenge)).event_id).toBe(receipt.event_id);
  expect(await failure(gateway.record(s.kiosk.id, 'CLOCK_OUT', version, challenge))).toBe('FORBIDDEN');
  // Expired challenge (server TTL 60 s, moved to the past) is rejected.
  const second = randomUUID();
  const pause = await gateway.authenticate(s.kiosk.code, pin, 'BREAK_START', receipt.version, second);
  sql(`update private.kiosk_challenges set created_at=statement_timestamp()-interval '62 seconds',expires_at=statement_timestamp()-interval '2 seconds' where request_id='${second}';`);
  expect(await failure(gateway.record(s.kiosk.id, 'BREAK_START', receipt.version, { challenge: pause.challenge, requestId: second }))).toBe('FORBIDDEN');
  expect(eventCount(s.org, s.kiosk.id)).toBe(1);
  // Revoked device: even the correct PIN is refused with the same generic error.
  await go(page, 'Kioscos');
  await page.getByRole('button', { name: `Revocar kiosco terminado en ${setup.deviceId.slice(-6)}` }).click();
  await page.getByRole('dialog', { name: 'Revocar kiosco' }).getByRole('button', { name: 'Revocar' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kiosco revocado' })).toBeVisible();
  expect(await failure(gateway.authenticate(s.kiosk.code, pin, 'BREAK_START', receipt.version, randomUUID()))).toBe('FORBIDDEN');

  // Synthetic PIN, device credential and tokens: absent from browser storage,
  // Cache Storage, console, gateway/signer logs and test artefacts.
  const secrets = [pin, setup.password, code, token, auth.challenge];
  expectAbsent(JSON.stringify(await browserPersistence(page)), secrets, 'browser storage and caches');
  expectAbsent(consoleLines.join('\n'), secrets, 'browser console');
  expectAbsent(serviceLogs(), secrets, 'gateway and signer logs');
  for (const file of [...filesUnder(testInfo.outputDir), ...filesUnder(RUN_DIR)]) {
    expectAbsent(readFileSync(file, 'latin1'), secrets, 'test artefacts');
  }
});

import { expect, type Browser, type BrowserContextOptions, type Page, type TestInfo } from '@playwright/test';
import { parseDeviceSetup } from '../../../src/lib/codes';
import { go } from './ui';

// Manager UI: prepares a kiosk and returns the one-time setup code.
export async function provisionKiosk(page: Page, name: string) {
  await go(page, 'Kioscos');
  await page.getByRole('button', { name: 'Preparar un kiosco' }).click();
  const dialog = page.getByRole('dialog', { name: 'Preparar un kiosco' });
  await dialog.getByLabel('Nombre del kiosco').fill(name);
  await dialog.getByRole('button', { name: 'Preparar' }).click();
  const code = (await dialog.locator('.secret-code').textContent())!.trim();
  await dialog.getByRole('button', { name: 'He configurado el dispositivo; cerrar' }).click();
  await expect(dialog).toHaveCount(0);
  return { code, setup: parseDeviceSetup(code)! };
}

// Manager UI: generates a random PIN shown exactly once.
export async function issuePin(page: Page, employeeName: string): Promise<string> {
  await go(page, 'Empleados');
  await page.getByRole('button', { name: `Ver ficha de ${employeeName}` }).click();
  await page.getByRole('button', { name: 'Generar PIN de kiosco' }).click();
  await page.getByRole('dialog', { name: 'Generar PIN de kiosco' }).getByRole('button', { name: 'Generar PIN' }).click();
  const shown = page.getByRole('dialog', { name: 'PIN de kiosco generado' });
  const pin = (await shown.locator('.secret-value').textContent())!.replace(/\s/g, '');
  expect(/^\d{8}$/.test(pin)).toBe(true);
  await shown.getByRole('button', { name: 'He entregado el PIN; cerrar' }).click();
  await expect(shown).toHaveCount(0);
  return pin;
}

// A separate browser context stands for the shared kiosk device.
export async function openKiosk(browser: Browser, testInfo: TestInfo, setupCode: string) {
  const context = await browser.newContext({ ...(testInfo.project.use as BrowserContextOptions), serviceWorkers: 'block' });
  const kiosk = await context.newPage();
  const consoleLines: string[] = [];
  kiosk.on('console', (message) => consoleLines.push(message.text()));
  await kiosk.goto('/kiosco');
  await kiosk.getByLabel('Código de configuración').fill(setupCode);
  await kiosk.getByRole('button', { name: 'Configurar' }).click();
  await expect(kiosk.getByRole('heading', { name: 'Identifícate para fichar' })).toBeVisible();
  return { context, kiosk, consoleLines };
}

export async function identify(kiosk: Page, code: string, pin: string) {
  await kiosk.getByLabel('Código de empleado').fill(code);
  await kiosk.getByRole('button', { name: 'Continuar' }).click();
  await kiosk.getByLabel('PIN (8 cifras)').fill(pin);
  await kiosk.getByRole('button', { name: 'Continuar' }).click();
}

export const GENERIC_FAILURE = 'No se ha podido identificar. Comprueba el código y el PIN o avisa a tu empresa.';

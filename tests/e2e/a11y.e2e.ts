import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { audit, structure, targets } from './support/a11y';
import { addMember, clock, rpc, scenario, sql } from './support/backend';
import { go, login } from './support/ui';

test.use({ serviceWorkers: 'block' });

test('employee screens pass axe, structure and target-size checks', async ({ page }) => {
  const s = await scenario();
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_OUT', 1);
  await page.goto('/');
  await structure(page, false);
  await audit(page, 'login');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('alert')).toContainText('Revisa los campos marcados');
  await audit(page, 'login with errors');
  await login(page, s.employee);
  await structure(page);
  await targets(page);
  await audit(page, 'clock');
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  await audit(page, 'clock receipt');
  await go(page, 'Mi registro');
  await expect(page.locator('article.session').first()).toBeVisible();
  await structure(page);
  await targets(page);
  await audit(page, 'evidence');
  await page.getByRole('button', { name: 'Solicitar corrección de esta jornada' }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await audit(page, 'correction dialog');
  await page.keyboard.press('Escape');
  await go(page, 'Mis correcciones');
  await audit(page, 'corrections');
  await go(page, 'Exportar mi registro');
  await targets(page);
  await audit(page, 'export');
});

test('management and kiosk screens pass axe checks', async ({ page }) => {
  const s = await scenario();
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_OUT', 1);
  const event = sql(`select id||'|'||session_id||'|'||to_json(server_at) from public.time_events where employee_id='${s.employee.employee}' and sequence=1;`).split('|');
  await rpc('submit_correction', s.employee.token, { p_organization_id: s.org, p_request_id: randomUUID(), p_employee_id: s.employee.employee,
    p_base_version: 2, p_reason: 'Motivo sintético', p_operations: [{ operation: 'REPLACE', target_event_id: event[0], session_id: event[1],
      event_type: 'CLOCK_IN', effective_at: new Date(new Date(JSON.parse(event[2])).getTime() - 60_000).toISOString(), timezone: 'Europe/Madrid', ordinal: 1 }] });
  await login(page, s.owner);
  for (const [name, check] of [['Empleados', 'row'], ['Personas y roles', 'row'], ['Horarios', 'row'], ['Solicitudes de corrección', 'listitem'],
    ['Clasificación de horas', 'combobox'], ['Exportaciones', 'button'], ['Kioscos', 'button']] as const) {
    await go(page, name);
    await expect(page.getByRole(check).first()).toBeVisible();
    await structure(page);
    await targets(page);
    await audit(page, name);
  }
  await go(page, 'Solicitudes de corrección');
  await page.getByRole('button', { name: /Rechazar/ }).click();
  await audit(page, 'decision dialog');
  await page.keyboard.press('Escape');
  await go(page, 'Empleados');
  await page.getByRole('button', { name: 'Ver ficha de Elena Empleada' }).click();
  await expect(page.locator('article.session').first()).toBeVisible();
  await audit(page, 'employee file');
  await go(page, 'Kioscos');
  await page.getByRole('button', { name: 'Preparar un kiosco' }).click();
  await audit(page, 'provision dialog');
  await page.keyboard.press('Escape');
  await page.goto('/kiosco');
  await expect(page.getByRole('heading', { name: 'Configurar este dispositivo' })).toBeVisible();
  await structure(page, false);
  await audit(page, 'kiosk setup');
  const multi = await addMember(s.org, s.owner, 'EMPLOYEE');
  const other = await scenario();
  await addMember(other.org, other.owner, 'EMPLOYEE', multi);
  await page.goto('/');
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await login(page, multi);
  await expect(page.getByRole('heading', { name: 'Elige organización' })).toBeVisible();
  await audit(page, 'organization picker');
});

test('keyboard only: skip link, login, clock, focus order and visible focus', { tag: '@desktop-only' }, async ({ page }) => {
  const s = await scenario();
  await page.goto('/');
  await expect(page.getByLabel('Correo electrónico')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Correo electrónico')).toBeFocused();
  await page.keyboard.type(s.employee.email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Contraseña')).toBeFocused();
  await page.keyboard.type(s.employee.password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Fichar' })).toBeFocused();
  // From the page title the next stop is the only valid action.
  await page.keyboard.press('Tab');
  const entrada = page.getByRole('button', { name: 'Entrada', exact: true });
  await expect(entrada).toBeFocused();
  const outline = await entrada.evaluate((el) => { const c = getComputedStyle(el); return { style: c.outlineStyle, width: parseFloat(c.outlineWidth) }; });
  expect(outline.style).toBe('solid');
  expect(outline.width).toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Iniciar pausa' })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.getByRole('heading', { name: 'Pausa iniciada' })).toBeFocused();

  // Reading order backwards from the page title: navigation, header, skip link.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Fichar' })).toBeFocused();
  const backwards: string[] = [];
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Shift+Tab');
    backwards.push(await page.evaluate(() => (document.activeElement?.textContent ?? '').trim()));
  }
  expect(backwards).toEqual(['Exportar mi registro', 'Mis correcciones', 'Mi registro', 'Fichar', 'Cerrar sesión', 'Saltar al contenido principal']);
  const box = await page.getByRole('link', { name: 'Saltar al contenido principal' }).boundingBox();
  expect(box && box.y >= 0).toBe(true);
  await page.keyboard.press('Enter');
  await expect(page.locator('#contenido')).toBeFocused();

  // Navigation by keyboard moves focus to the new page title.
  await page.getByRole('link', { name: 'Mi registro', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Mi registro' })).toBeFocused();
  await expect(page).toHaveTitle('Mi registro · Fichaje');
});

test('dialogs trap focus, close with Escape and return focus to the opener', { tag: '@desktop-only' }, async ({ page }) => {
  const s = await scenario();
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await login(page, s.employee);
  await go(page, 'Mi registro');
  const opener = page.getByRole('button', { name: 'Solicitar corrección de esta jornada' });
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Solicitar corrección de la jornada' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate((d) => d.contains(document.activeElement) || document.activeElement === document.body);
    expect(inside).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('reflow at 320 px and 200 % text size without horizontal scrolling', { tag: '@desktop-only' }, async ({ page }) => {
  const s = await scenario();
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_OUT', 1);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await page.setViewportSize({ width: 320, height: 640 });
  await login(page, s.owner);
  for (const name of ['Fichar', 'Mi registro', 'Empleados', 'Personas y roles', 'Solicitudes de corrección', 'Kioscos']) {
    await go(page, name);
    await page.waitForLoadState('networkidle');
    expect(await overflow(), `horizontal overflow at 320 px on ${name}`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  for (const name of ['Fichar', 'Mi registro', 'Empleados']) {
    await go(page, name);
    await page.waitForLoadState('networkidle');
    expect(await overflow(), `horizontal overflow with 200 % text on ${name}`).toBeLessThanOrEqual(0);
    await expect(page.getByRole('heading', { level: 1 })).toBeInViewport();
  }
});

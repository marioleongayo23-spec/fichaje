import { expect, test, type Page } from '@playwright/test';
import { clock, eventCount, scenario } from './support/backend';
import { browserPersistence, go, JWT_PATTERN, login } from './support/ui';

// Service workers are enabled in this file (the default): these tests exercise
// the real production build served by `vite preview`.
async function controlled(page: Page) {
  await page.waitForFunction(async () => {
    const registration = await navigator.serviceWorker.ready;
    return registration.active?.state === 'activated' && navigator.serviceWorker.controller !== null;
  }, undefined, { timeout: 20_000 });
}

function png(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('manifest is valid and Chrome reports the app as installable', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ name: 'Fichaje', short_name: 'Fichaje', lang: 'es', start_url: '/', scope: '/', display: 'standalone' });
  for (const icon of manifest.icons) {
    const size = png(await (await page.request.get(icon.src)).body());
    expect(size && `${size.width}x${size.height}`).toBe(icon.sizes);
  }
  expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '192x192')).toBe(true);
  expect(manifest.icons.some((i: { sizes: string; purpose: string }) => i.sizes === '512x512' && i.purpose === 'maskable')).toBe(true);
  await controlled(page);
  const cdp = await page.context().newCDPSession(page);
  const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
  expect(installabilityErrors).toEqual([]);
});

test('offline: shell loads, clocking is impossible and never queued; reconnection reloads server state', async ({ page, context }) => {
  const s = await scenario();
  let clockRequests = 0;
  page.on('request', (r) => { if (r.url().includes('/rpc/record_time_event')) clockRequests++; });
  await login(page, s.employee);
  await controlled(page);
  await expect(page.getByRole('button', { name: 'Entrada', exact: true })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByRole('status').filter({ hasText: 'Sin conexión.' }).first()).toBeVisible();
  await expect(page.getByText('Sin conexión: no se puede fichar.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Entrada', exact: true })).toHaveCount(0);
  await expect(page.getByText(/contingencia/).first()).toBeVisible();

  // The public shell is served from the service worker cache while offline,
  // with no labour data available (nothing cached, nothing invented).
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No se pueden cargar tus datos' })).toBeVisible();
  await expect(page.getByText('Trabajando')).toHaveCount(0);
  const kiosk = await context.newPage();
  await kiosk.goto('/kiosco');
  await expect(kiosk.getByRole('heading', { name: 'Configurar este dispositivo' })).toBeVisible();
  await kiosk.close();

  // Meanwhile the state changes on the server (another device).
  await clock(s.org, s.employee, s.employee.employee!, 'CLOCK_IN', 0);
  await context.setOffline(false);
  await expect(page.locator('.state-value')).toHaveText('Trabajando');
  await expect(page.getByRole('button', { name: 'Salida' })).toBeVisible();
  expect(clockRequests).toBe(0); // earlier clicks are never replayed
  expect(eventCount(s.org, s.employee.employee!)).toBe(1);

  // Back online the page reconnects: going offline again then online refreshes.
  await context.setOffline(true);
  await expect(page.getByText('Sin conexión: no se puede fichar.')).toBeVisible();
  await context.setOffline(false);
  await expect(page.getByRole('status').filter({ hasText: 'Conexión restablecida' })).toBeVisible();
  await expect(page.locator('.state-value')).toHaveText('Trabajando');
  expect(clockRequests).toBe(0);
});

test('Cache Storage and browser storage never hold API, Auth, tokens, PIN, records or exports', async ({ page }) => {
  const s = await scenario();
  await login(page, s.employee);
  await controlled(page);
  const clocked = page.waitForResponse((r) => r.url().includes('/rpc/record_time_event'));
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  const receipt = await (await clocked).json();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();
  await go(page, 'Mi registro');
  await expect(page.locator('article.session')).toHaveCount(1);
  await go(page, 'Exportar mi registro');
  const requested = page.waitForResponse((r) => r.url().includes('/rpc/request_export'));
  await page.getByRole('button', { name: 'Solicitar exportación' }).click();
  const job = await (await requested).json();
  await expect(page.getByRole('status').filter({ hasText: 'Exportación solicitada' })).toBeVisible();
  const session = await page.evaluate(() => JSON.parse(localStorage.getItem('fichaje-auth') ?? '{}'));
  // Concrete values that must never be cached (code identifiers are not data).
  const values = [s.employee.email, 'Elena Empleada', s.org, receipt.event_id, receipt.server_at, receipt.session_id,
    job.job_id, session.access_token, session.refresh_token];

  const precache: string[] = JSON.parse(/JSON\.parse\(`(\[.*?\])`\)/.exec(await (await page.request.get('/sw.js')).text())![1]);
  const stored = await browserPersistence(page);
  expect(stored.caches.length).toBe(precache.length);
  for (const entry of stored.caches) {
    const url = new URL(entry.url);
    expect(url.origin).toBe('http://127.0.0.1:4173');
    expect(precache).toContain(url.pathname);
    expect(url.pathname).not.toMatch(/\/(rest|auth|storage|functions|gateway)\/|rpc|token/);
    expect(JWT_PATTERN.test(entry.body)).toBe(false);
    expect(values.filter((v) => v && entry.body.includes(v)).length, 'cache body contains sensitive data').toBe(0);
  }
  expect(stored.caches.every((c) => c.cache.startsWith('fichaje-shell-'))).toBe(true);
  // Web Storage: only the Supabase Auth session (restored by Supabase Auth).
  expect(Object.keys(stored.local)).toEqual(['fichaje-auth']);
  expect(stored.session).toEqual({});
  expect(stored.databases).toEqual([]);
  const local = JSON.stringify(stored.local);
  const labour = [receipt.event_id, receipt.server_at, receipt.session_id, job.job_id, 'Elena Empleada', s.org, 'CLOCK_IN'];
  expect(labour.filter((v) => local.includes(v)).length, 'labour data in localStorage').toBe(0);
  // Logging out removes the stored session.
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  expect(Object.keys((await browserPersistence(page)).local)).toEqual([]);
});

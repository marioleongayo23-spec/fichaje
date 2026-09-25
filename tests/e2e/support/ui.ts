import { expect, type Page } from '@playwright/test';
import type { Account } from './backend';

export async function login(page: Page, account: Pick<Account, 'email' | 'password'>) {
  await page.goto('/');
  await page.getByLabel('Correo electrónico').fill(account.email);
  await page.getByLabel('Contraseña').fill(account.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { level: 1 })).not.toHaveText('Iniciar sesión');
}

export async function go(page: Page, name: string) {
  const toggle = page.getByRole('navigation', { name: 'Principal' }).getByRole('button', { expanded: false });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('navigation', { name: 'Principal' }).getByRole('link', { name, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: 'Cerrar sesión' }).click();
  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
}

// Everything the browser keeps: Web Storage, IndexedDB names and every Cache
// Storage entry (URL + body). Used to prove nothing sensitive persists.
export async function browserPersistence(page: Page) {
  return page.evaluate(async () => {
    const local = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) ?? '']));
    const session = Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k) ?? '']));
    const databases = 'databases' in indexedDB ? (await indexedDB.databases()).map((d) => d.name ?? '') : [];
    const caches_: { cache: string; url: string; body: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        caches_.push({ cache: name, url: request.url, body: response ? await response.clone().text() : '' });
      }
    }
    return { local, session, databases, caches: caches_ };
  });
}

// Boolean assertions only: a failure never prints the secret itself.
export function expectAbsent(haystack: string, secrets: string[], where: string) {
  const leaked = secrets.filter((s) => s && haystack.includes(s)).length;
  expect(leaked, `${leaked} synthetic secret(s) found in ${where}`).toBe(0);
}

export const JWT_PATTERN = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/;

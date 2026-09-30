import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createAccount, sql } from './support/backend';
import { login } from './support/ui';

test('public registration creates only an unverified Auth identity, never a tenant or role', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const email = `signup-${randomBytes(6).toString('hex')}@example.invalid`;
  const password = `Aa9!${randomBytes(18).toString('base64url')}`;

  await page.goto('/');
  await page.getByRole('button', { name: 'Dar de alta una empresa' }).click();
  await expect(page.getByRole('heading', { name: 'Crear cuenta' })).toBeVisible();
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña', { exact: true }).fill(password);
  await page.getByLabel('Repite la contraseña').fill(password);
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click();

  await expect(page.getByRole('heading', { name: 'Iniciar sesión' })).toBeVisible();
  await expect(page.getByText('Cuenta creada. Revisa tu correo y confirma la dirección antes de iniciar sesión.')).toBeVisible();

  expect(pageErrors).toEqual([]);
  await expect(page.getByLabel('Correo electrónico')).toHaveValue('');
  await expect(page.getByLabel('Contraseña', { exact: true })).toHaveValue('');

  expect(sql(`select count(*) from auth.users where email='${email}' and email_confirmed_at is null;`)).toBe('1');
  expect(sql(`select count(*) from public.memberships m join auth.users u on u.id=m.auth_user_id where u.email='${email}';`)).toBe('0');
});

test('verified account creates its first company from the app and becomes OWNER', async ({ page }) => {
  const owner = await createAccount('self-service-owner');
  const name = `Fichaje Demo ${randomBytes(3).toString('hex')}`;

  await login(page, owner);
  await expect(page.getByRole('heading', { name: 'Configura tu acceso' })).toBeVisible();
  await page.getByLabel('Nombre de la empresa').fill(name);
  await page.getByRole('button', { name: 'Crear empresa' }).click();

  await expect(page.getByRole('heading', { name: 'Empleados' })).toBeVisible();
  expect(sql(`select count(*) from public.organizations o join public.memberships m on m.organization_id=o.id
    where o.name='${name}' and m.auth_user_id='${owner.id}' and m.role='OWNER' and m.active;`)).toBe('1');
});

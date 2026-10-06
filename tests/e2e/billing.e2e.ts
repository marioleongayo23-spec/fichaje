import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { createAccount, sql } from './support/backend';

test('commercial /contratar entry creates a company and hands checkout to Stripe @desktop-only', async ({ page }) => {
  const owner = await createAccount('billing-commercial');
  const company = `Bundy Test ${randomBytes(3).toString('hex')}`;
  let checkoutBody: Record<string, unknown> | null = null;
  let authHeader = '';

  await page.route('**/gateway/billing/checkout', async (route) => {
    checkoutBody = JSON.parse(route.request().postData() ?? '{}');
    authHeader = route.request().headers()['authorization'] ?? '';
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_SyntheticBundy' }) });
  });
  await page.route('https://checkout.stripe.com/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/html',
      body: '<title>Stripe test checkout</title><h1>Stripe test checkout</h1>' });
  });

  await page.goto('/contratar');
  await expect(page.getByRole('heading', { name: 'Crear cuenta' })).toBeVisible();
  await page.getByRole('button', { name: 'Ya tengo una cuenta' }).click();
  await page.getByLabel('Correo electrónico').fill(owner.email);
  await page.getByLabel('Contraseña').fill(owner.password);
  await page.getByRole('button', { name: 'Entrar' }).click();

  await expect(page.getByRole('heading', { name: 'Configura tu acceso' })).toBeVisible();
  await page.getByLabel('Nombre de la empresa').fill(company);
  await page.getByRole('button', { name: 'Crear empresa y continuar' }).click();

  await expect(page.getByRole('heading', { name: 'Facturación' })).toBeVisible();
  await expect(page.getByText('Sin suscripción')).toBeVisible();
  await page.getByRole('button', { name: 'Contratar con Stripe' }).click();
  await expect(page).toHaveURL(/^https:\/\/checkout\.stripe\.com\//);
  await expect(page.getByRole('heading', { name: 'Stripe test checkout' })).toBeVisible();

  const org = sql(`select id from public.organizations where name='${company.replace(/'/g, "''")}';`);
  expect(org).toMatch(/^[0-9a-f-]{36}$/);
  const captured = checkoutBody as unknown as Record<string, unknown> | null;
  expect(captured).toMatchObject({ organization_id: org });
  expect(String(captured?.request_id)).toMatch(/^[0-9a-f-]{36}$/);
  expect(authHeader).toMatch(/^Bearer eyJ/);
  expect(sql(`select count(*) from public.memberships where organization_id='${org}' and auth_user_id='${owner.id}' and role='OWNER' and active;`)).toBe('1');
});

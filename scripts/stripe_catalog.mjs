#!/usr/bin/env node
// Stripe catalog bootstrap for Fichaje APP.
//
// Safe by default: without --apply this process performs no network request.
// STRIPE_SECRET_KEY is read only from the environment and is never printed.
// Live mode requires an extra literal confirmation.
//
// The catalog is two recurring Prices under one Product:
// - fixed 12.99 EUR/month
// - graduated licensed seats: 1-5 free, 6-20 1.99, 21-100 1.49, 101+ 1.29 EUR

const API = 'https://api.stripe.com/v1';
const CATALOG_VERSION = '2026-10-v1';
const PRODUCT_MARKER = 'fichaje_app_time_tracking';
const BASE_LOOKUP = 'fichaje_base_monthly_v1';
const EMPLOYEE_LOOKUP = 'fichaje_employees_monthly_v1';

function argsOf(argv) {
  const result = { mode: 'test', apply: false, confirmLive: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') result.apply = true;
    else if (arg === '--mode') result.mode = argv[++i];
    else if (arg === '--confirm-live') result.confirmLive = argv[++i];
    else if (arg === '--dry-run') result.apply = false;
    else throw new Error('UNKNOWN_ARGUMENT:' + arg);
  }
  if (!['test', 'live'].includes(result.mode)) throw new Error('MODE_MUST_BE_TEST_OR_LIVE');
  return result;
}

function tierCostCents(quantity) {
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error('INVALID_EMPLOYEE_QUANTITY');
  let remaining = quantity;
  let cents = 0;
  const tiers = [
    [5, 0],
    [15, 199],
    [80, 149],
    [Infinity, 129],
  ];
  for (const [width, amount] of tiers) {
    const units = Math.min(remaining, width);
    cents += units * amount;
    remaining -= units;
    if (remaining <= 0) break;
  }
  return cents;
}

function totalMonthlyCents(quantity) {
  return 1299 + tierCostCents(quantity);
}

function catalogView() {
  const examples = [0, 1, 5, 10, 20, 25, 50, 100, 250, 500].map((employees) => ({
    employees,
    monthly_cents: totalMonthlyCents(employees),
  }));
  return {
    catalog_version: CATALOG_VERSION,
    currency: 'eur',
    base: { lookup_key: BASE_LOOKUP, monthly_cents: 1299 },
    employees: {
      lookup_key: EMPLOYEE_LOOKUP,
      usage_type: 'licensed',
      billing_scheme: 'tiered',
      tiers_mode: 'graduated',
      tiers: [
        { up_to: 5, unit_amount: 0 },
        { up_to: 20, unit_amount: 199 },
        { up_to: 100, unit_amount: 149 },
        { up_to: 'inf', unit_amount: 129 },
      ],
    },
    examples,
    runtime_env_names: [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PRICE_BASE_MONTHLY',
      'STRIPE_PRICE_EMPLOYEES_MONTHLY',
      'FICHAJE_BILLING_ENABLED',
    ],
  };
}

function assertSecretMode(secret, mode) {
  if (!secret) throw new Error('STRIPE_SECRET_KEY_REQUIRED');
  if (mode === 'test' && !secret.startsWith('sk_test_')) throw new Error('TEST_MODE_REQUIRES_SK_TEST_KEY');
  if (mode === 'live' && !secret.startsWith('sk_live_')) throw new Error('LIVE_MODE_REQUIRES_SK_LIVE_KEY');
}

async function stripe(secret, method, path, form, idempotencyKey) {
  const headers = {
    Authorization: 'Bearer ' + secret,
    Accept: 'application/json',
  };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const response = await fetch(API + path, { method, headers, body, redirect: 'error' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code || payload?.error?.type || 'STRIPE_API_ERROR';
    throw new Error('STRIPE_API_ERROR:' + code);
  }
  return payload;
}

async function listAllProducts(secret) {
  const out = [];
  let startingAfter = null;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ active: 'true', limit: '100' });
    if (startingAfter) query.set('starting_after', startingAfter);
    const payload = await stripe(secret, 'GET', '/products?' + query.toString());
    out.push(...(payload.data || []));
    if (!payload.has_more) return out;
    startingAfter = payload.data?.at(-1)?.id;
    if (!startingAfter) break;
  }
  throw new Error('PRODUCT_LIST_PAGINATION_LIMIT');
}

async function ensureProduct(secret, mode) {
  const products = await listAllProducts(secret);
  const existing = products.find((product) =>
    product?.metadata?.fichaje_product === PRODUCT_MARKER &&
    product?.metadata?.fichaje_catalog_version === CATALOG_VERSION);
  if (existing) return { id: existing.id, created: false };
  const form = {
    name: 'Fichaje APP',
    description: 'Registro horario SaaS multiempresa',
    'metadata[fichaje_product]': PRODUCT_MARKER,
    'metadata[fichaje_catalog_version]': CATALOG_VERSION,
  };
  const created = await stripe(secret, 'POST', '/products', form, 'fichaje-' + mode + '-product-' + CATALOG_VERSION);
  return { id: created.id, created: true };
}

async function findPrice(secret, lookupKey) {
  const query = new URLSearchParams({ active: 'true', limit: '10' });
  query.append('lookup_keys[]', lookupKey);
  const payload = await stripe(secret, 'GET', '/prices?' + query.toString());
  if ((payload.data || []).length > 1) throw new Error('DUPLICATE_LOOKUP_KEY:' + lookupKey);
  return payload.data?.[0] || null;
}

function validateBase(price, productId) {
  return price.product === productId &&
    price.currency === 'eur' &&
    price.unit_amount === 1299 &&
    price.billing_scheme === 'per_unit' &&
    price.recurring?.interval === 'month' &&
    price.recurring?.usage_type === 'licensed';
}

function validateEmployees(price, productId) {
  return price.product === productId &&
    price.currency === 'eur' &&
    price.billing_scheme === 'tiered' &&
    price.tiers_mode === 'graduated' &&
    price.recurring?.interval === 'month' &&
    price.recurring?.usage_type === 'licensed';
}

async function ensureBasePrice(secret, mode, productId) {
  const existing = await findPrice(secret, BASE_LOOKUP);
  if (existing) {
    if (!validateBase(existing, productId)) throw new Error('BASE_LOOKUP_KEY_CONFIG_MISMATCH');
    return { id: existing.id, created: false };
  }
  const form = {
    product: productId,
    currency: 'eur',
    unit_amount: '1299',
    'recurring[interval]': 'month',
    'recurring[usage_type]': 'licensed',
    lookup_key: BASE_LOOKUP,
    nickname: 'Fichaje APP base monthly v1',
    'metadata[fichaje_catalog_version]': CATALOG_VERSION,
  };
  const created = await stripe(secret, 'POST', '/prices', form, 'fichaje-' + mode + '-price-base-' + CATALOG_VERSION);
  return { id: created.id, created: true };
}

async function ensureEmployeePrice(secret, mode, productId) {
  const existing = await findPrice(secret, EMPLOYEE_LOOKUP);
  if (existing) {
    if (!validateEmployees(existing, productId)) throw new Error('EMPLOYEE_LOOKUP_KEY_CONFIG_MISMATCH');
    return { id: existing.id, created: false };
  }
  const form = {
    product: productId,
    currency: 'eur',
    billing_scheme: 'tiered',
    tiers_mode: 'graduated',
    'recurring[interval]': 'month',
    'recurring[usage_type]': 'licensed',
    lookup_key: EMPLOYEE_LOOKUP,
    nickname: 'Fichaje APP employees monthly v1',
    'metadata[fichaje_catalog_version]': CATALOG_VERSION,
    'tiers[0][up_to]': '5',
    'tiers[0][unit_amount]': '0',
    'tiers[1][up_to]': '20',
    'tiers[1][unit_amount]': '199',
    'tiers[2][up_to]': '100',
    'tiers[2][unit_amount]': '149',
    'tiers[3][up_to]': 'inf',
    'tiers[3][unit_amount]': '129',
  };
  const created = await stripe(secret, 'POST', '/prices', form, 'fichaje-' + mode + '-price-employees-' + CATALOG_VERSION);
  return { id: created.id, created: true };
}

async function main() {
  const options = argsOf(process.argv.slice(2));
  const view = catalogView();
  if (!options.apply) {
    process.stdout.write(JSON.stringify({ mode: options.mode, apply: false, network: false, ...view }, null, 2) + '\n');
    return;
  }

  const secret = process.env.STRIPE_SECRET_KEY || '';
  assertSecretMode(secret, options.mode);
  if (options.mode === 'live' && options.confirmLive !== 'FICHAJE-LIVE') {
    throw new Error('LIVE_MODE_REQUIRES_EXPLICIT_CONFIRMATION');
  }

  const product = await ensureProduct(secret, options.mode);
  const base = await ensureBasePrice(secret, options.mode, product.id);
  const employees = await ensureEmployeePrice(secret, options.mode, product.id);

  process.stdout.write(JSON.stringify({
    mode: options.mode,
    apply: true,
    catalog_version: CATALOG_VERSION,
    product: { id: product.id, created: product.created },
    prices: {
      base: { id: base.id, lookup_key: BASE_LOOKUP, created: base.created },
      employees: { id: employees.id, lookup_key: EMPLOYEE_LOOKUP, created: employees.created },
    },
    set_runtime_env: {
      STRIPE_PRICE_BASE_MONTHLY: base.id,
      STRIPE_PRICE_EMPLOYEES_MONTHLY: employees.id,
    },
    secret_values_printed: false,
  }, null, 2) + '\n');
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
  process.stderr.write('stripe_catalog: ' + message + '\n');
  process.exitCode = 1;
});

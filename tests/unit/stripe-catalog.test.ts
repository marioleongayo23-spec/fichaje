import { execFileSync, spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function dryRun(mode = 'test') {
  const output = execFileSync(process.execPath, ['scripts/stripe_catalog.mjs', '--mode', mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, STRIPE_SECRET_KEY: '' },
  });
  return JSON.parse(output) as {
    mode: string;
    apply: boolean;
    network: boolean;
    base: { monthly_cents: number; lookup_key: string };
    employees: { lookup_key: string; tiers: Array<{ up_to: number | string; unit_amount: number }> };
    examples: Array<{ employees: number; monthly_cents: number }>;
  };
}

describe('Stripe catalog readiness', () => {
  it('is network-free by default and exposes the approved progressive pricing', () => {
    const catalog = dryRun();
    expect(catalog).toMatchObject({ mode: 'test', apply: false, network: false });
    expect(catalog.base).toEqual({ lookup_key: 'fichaje_base_monthly_v1', monthly_cents: 1299 });
    expect(catalog.employees.lookup_key).toBe('fichaje_employees_monthly_v1');
    expect(catalog.employees.tiers).toEqual([
      { up_to: 5, unit_amount: 0 },
      { up_to: 20, unit_amount: 199 },
      { up_to: 100, unit_amount: 149 },
      { up_to: 'inf', unit_amount: 129 },
    ]);
    const byEmployees = new Map(catalog.examples.map((row) => [row.employees, row.monthly_cents]));
    expect(byEmployees.get(0)).toBe(1299);
    expect(byEmployees.get(5)).toBe(1299);
    expect(byEmployees.get(10)).toBe(2294);
    expect(byEmployees.get(20)).toBe(4284);
    expect(byEmployees.get(25)).toBe(5029);
    expect(byEmployees.get(100)).toBe(16204);
    expect(byEmployees.get(250)).toBe(35554);
    expect(byEmployees.get(500)).toBe(67804);
  });

  it('never applies without an environment secret and rejects test/live key confusion before network I/O', () => {
    const missing = spawnSync(process.execPath, ['scripts/stripe_catalog.mjs', '--mode', 'test', '--apply'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, STRIPE_SECRET_KEY: '' },
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('STRIPE_SECRET_KEY_REQUIRED');

    const syntheticLiveKey = ['sk', 'live', 'synthetic-never-sent'].join('_');
    const wrong = spawnSync(process.execPath, ['scripts/stripe_catalog.mjs', '--mode', 'test', '--apply'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, STRIPE_SECRET_KEY: syntheticLiveKey },
    });
    expect(wrong.status).not.toBe(0);
    expect(wrong.stderr).toContain('TEST_MODE_REQUIRES_SK_TEST_KEY');
  });

  it('requires an additional deliberate confirmation for live mode before any Stripe request', () => {
    const syntheticLiveKey = ['sk', 'live', 'synthetic-never-sent'].join('_');
    const result = spawnSync(process.execPath, ['scripts/stripe_catalog.mjs', '--mode', 'live', '--apply'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, STRIPE_SECRET_KEY: syntheticLiveKey },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('LIVE_MODE_REQUIRES_EXPLICIT_CONFIRMATION');
  });
});

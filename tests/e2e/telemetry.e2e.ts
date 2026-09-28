import { expect, test } from '@playwright/test';
import { scenario, sql } from './support/backend';
import { login } from './support/ui';

// OPS-02 OBS-02 in a real browser: the page aggregates request telemetry and
// sends it through the write-only RPC. Only operation, outcome, stable error
// class and latency buckets leave the browser; the database stores 5-minute
// aggregates with no tenant, person, record, request or release (SEC-OPS-01).
test.use({ serviceWorkers: 'block' });

const total = () => Number(sql("select coalesce(sum(requests),0) from private.ops_client_metrics where operation='clock.CLOCK_IN' and outcome='success' and error_class='NONE';"));

test('browser telemetry leaves only bounded aggregates @desktop-only', async ({ page }) => {
  const s = await scenario();
  const before = total();
  const bodies: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/rest/v1/rpc/ops_ingest_client_metrics')) bodies.push(r.postData() ?? ''); });
  await login(page, s.employee);
  const clocked = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/record_time_event'));
  await page.getByRole('button', { name: 'Entrada', exact: true }).click();
  const receipt = await (await clocked).json();
  await expect(page.getByRole('heading', { name: 'Entrada registrada' })).toBeVisible();

  // Leaving the page flushes (same trigger as closing the tab or locking a phone).
  const flushed = page.waitForResponse((r) => r.url().includes('/rest/v1/rpc/ops_ingest_client_metrics'));
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  expect((await flushed).status()).toBe(200);

  const payload = JSON.parse(bodies.at(-1) ?? '{}');
  expect(Object.keys(payload)).toEqual(['p_batch']);
  const item = payload.p_batch.find((x: { operation: string; outcome: string }) => x.operation === 'clock.CLOCK_IN' && x.outcome === 'success');
  expect(item).toMatchObject({ error_class: 'NONE', count: 1 });
  for (const entry of payload.p_batch) expect(Object.keys(entry).sort()).toEqual(['buckets', 'count', 'error_class', 'operation', 'outcome', 'sum_ms']);
  const body = bodies.join('\n');
  for (const value of [s.org, s.employee.employee!, s.employee.email, s.employee.membership, receipt.event_id, receipt.request_id, receipt.session_id]) {
    expect(body).not.toContain(value);
  }
  expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-|@|eyJ/);
  await expect.poll(total).toBeGreaterThanOrEqual(before + 1);
  // The store has no identity or release column at all: only the bucket and bounded labels.
  expect(sql("select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_schema='private' and table_name='ops_client_metrics';"))
    .toBe('bucket_start,operation,outcome,error_class,requests,duration_sum_ms,duration_buckets');
});

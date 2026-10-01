import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

it('keeps CI unprivileged and repository backup scheduled/manual, with no database job or secrets', () => {
  const ciText = readFileSync('.github/workflows/ci.yml', 'utf8');
  const ci = parse(ciText);
  const backupText = readFileSync('.github/workflows/backup.yml', 'utf8');
  const backup = parse(backupText);

  expect(ci.permissions).toEqual({ contents: 'read' });
  expect(ciText).not.toContain('secrets.');
  const ciRun = JSON.stringify(ci.jobs.validate.steps);
  expect(ciRun).toContain('npm ci --prefix edge');
  expect(ciRun).toContain('wrangler pages functions build functions');
  expect(ciRun).toContain('--outdir pages-worker');
  expect(ciRun).toContain('mv pages-upload/index.js pages-upload/_worker.js');
  const build = ci.jobs.validate.steps.find((s: { name?: string }) => s.name === 'Build');
  expect(build.env.VITE_SUPABASE_URL).toBe('https://pvfjffeszsedslmwdvgh.supabase.co');
  expect(build.env.VITE_SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);
  expect(JSON.stringify(build.env)).not.toMatch(/sb_secret_|service_role/);
  const upload = ci.jobs.validate.steps.find((s: { uses?: string }) => s.uses === 'actions/upload-artifact@v4');
  expect(upload.with.path).toBe('pages-upload/');
  expect(upload.with.name).toContain('pages-dist-');

  expect(Object.keys(backup.on).sort()).toEqual(['push', 'schedule', 'workflow_dispatch']);
  expect(backup.on.push.branches).toEqual(['main']);
  expect(backup.on.schedule).toEqual([{ cron: '30 1 * * *' }]);
  expect(Object.keys(backup.jobs)).toEqual(['repository']);
  expect(backup.permissions).toEqual({ contents: 'read' });
  expect(backup.jobs.repository.if).toBe("github.ref == 'refs/heads/main'");
  expect(backup.jobs.repository.steps[0].with['fetch-depth']).toBe(0);
  expect(backup.jobs.repository.steps[0].with['persist-credentials']).toBe(false);

  const run = JSON.stringify(backup.jobs.repository.steps);
  expect(run).not.toMatch(/backup_database|pg_dump/);
  expect(backupText).not.toContain('secrets.');
  expect(backupText).not.toMatch(/RCLONE_CONFIG|RCLONE_DESTINATION/);
  expect(run).toContain('"BACKUP_UPLOAD_DRIVE":"0"');
});

it('runs the H6 browser suite against a local ephemeral stack without secrets or artefact upload', () => {
  const text = readFileSync('.github/workflows/e2e.yml', 'utf8');
  const e2e = parse(text);
  expect(e2e.permissions).toEqual({ contents: 'read' });
  expect(text).not.toMatch(/\bsecrets\./);
  expect(text).not.toMatch(/upload-artifact|--trace|--video/);
  const run = JSON.stringify(e2e.jobs.browser.steps);
  expect(run).toContain('supabase db reset --local --no-seed');
  expect(run).toContain('tests/integration/journal_init.py');
  expect(run).toContain('npx playwright test');
  expect(run).toContain('scripts/scan_secrets.mjs dist test-results');
  expect(JSON.stringify(parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs.validate.steps)).toContain('npm run scan:secrets');
});

it('runs pgTAP and the full real H1-H5 chain, including KIO-H6-01, on every pull request', () => {
  const text = readFileSync('.github/workflows/database.yml', 'utf8');
  const db = parse(text);
  expect(db.on.pull_request.branches).toEqual(['main']);
  expect(db.permissions).toEqual({ contents: 'read' });
  expect(text).not.toMatch(/\bsecrets\./);
  const run = JSON.stringify(db.jobs.database.steps);
  for (const step of ['supabase db reset --local --no-seed', 'tests/integration/journal_init.py', 'supabase test db',
    'tests/integration/h5.py', 'deno check --config supabase/functions/kiosk/deno.json', 'deno test supabase/functions/kiosk/network_test.ts']) {
    expect(run).toContain(step);
  }
  // The KIO-H6-01 real suite is part of H4, which H5 runs first.
  expect(readFileSync('tests/integration/h5.py', 'utf8')).toContain("runpy.run_module('h4', run_name='__main__')");
  expect(readFileSync('tests/integration/h4.py', 'utf8')).toMatch(/import kio_h6\n\s+kio_h6\.run\(/);
  expect(readFileSync('supabase/tests/database/kiosk_identification.test.sql', 'utf8')).toContain('KIO-H6-01');
});

it('gates OPS-02 on every pull request with real fault injection, without secrets or uploaded artefacts', () => {
  const text = readFileSync('.github/workflows/ops02.yml', 'utf8');
  const ops = parse(text);
  expect(ops.on.pull_request.branches).toEqual(['main']);
  expect(ops.permissions).toEqual({ contents: 'read' });
  expect(text).not.toMatch(/\bsecrets\.|github\.token|upload-artifact/);
  const run = JSON.stringify(ops.jobs.ops02.steps);
  for (const step of ['python3 -m unittest discover -s tests/ops', 'deno test --allow-env=FICHAJE_RELEASE,FICHAJE_COMMIT --allow-read=ops/contract.json supabase/functions/_shared/ops_test.ts',
    'supabase db reset --local --no-seed', 'tests/integration/journal_init.py', 'supabase test db', 'python3 tests/integration/ops02.py',
    'supabase stop --no-backup']) {
    expect(run).toContain(step);
  }
  const suite = ops.jobs.ops02.steps.find((s: { run?: string }) => s.run === 'python3 tests/integration/ops02.py');
  expect(suite.env).toEqual({ OPS_FAULT_INJECTION: '1' });
  expect(JSON.stringify(parse(readFileSync('.github/workflows/ci.yml', 'utf8')).jobs.validate.steps)).toContain('python3 -m unittest discover -s tests/ops');
});

it('monitors backups on a schedule with a read-only token and never enables the database backup', () => {
  const text = readFileSync('.github/workflows/ops-monitor.yml', 'utf8');
  const monitor = parse(text);
  expect(Object.keys(monitor.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
  expect(monitor.permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(monitor.jobs.backups.if).toBe("github.ref == 'refs/heads/main'");
  expect(text).not.toMatch(/\bsecrets\.|upload-artifact|backup_database|pg_dump|RCLONE/);
  const run = JSON.stringify(monitor.jobs.backups.steps);
  expect(run).toContain('scripts/ops/backup_monitor.py');
  expect(run).toContain('scripts/ops/leakscan.py');
  expect(run).toContain('"GITHUB_TOKEN":"${{ github.token }}"');
});

it('gates H7 on every pull request with the edge, failure, incident, load and encrypted restore drills, without secrets or artefacts', () => {
  const text = readFileSync('.github/workflows/h7.yml', 'utf8');
  const h7 = parse(text);
  expect(h7.on.pull_request.branches).toEqual(['main']);
  expect(h7.permissions).toEqual({ contents: 'read' });
  expect(text).not.toMatch(/\bsecrets\.|github\.token|upload-artifact|CLOUDFLARE_API_TOKEN|SUPABASE_ACCESS_TOKEN|wrangler pages deploy|supabase (link|db push|functions deploy)/);
  expect(Object.keys(h7.jobs).sort()).toEqual(['edge', 'load', 'recovery']);
  const expected: Record<string, string[]> = {
    edge: ['npm ci --prefix edge', 'deno test supabase/functions/_shared/ingress_test.ts', 'supabase db reset --local --no-seed',
      'tests/integration/journal_init.py', 'python3 tests/integration/h7_edge.py', 'python3 tests/integration/h7_release.py',
      'python3 tests/integration/h7_incident.py', 'supabase stop --no-backup'],
    load: ['npm ci --prefix edge', 'supabase db reset --local --no-seed', 'python3 tests/integration/h7_load.py', 'supabase stop --no-backup'],
    recovery: ['sudo apt-get install -y age', 'tests/integration/journal_init.py', 'python3 tests/integration/rec.py', 'supabase stop --no-backup'],
  };
  for (const [job, steps] of Object.entries(expected)) {
    const run = JSON.stringify(h7.jobs[job].steps);
    for (const step of steps) expect(run).toContain(step);
    expect(h7.jobs[job].steps[0].with['persist-credentials']).toBe(false);
  }
  // The operator's staging verifier runs for real inside the edge suite, against the local staging shape.
  expect(readFileSync('tests/integration/h7_edge.py', 'utf8')).toContain("'scripts' / 'staging' / 'verify_staging.py'");
});


it('builds production candidates only from current main merge commits with all required gates green', () => {
  const text = readFileSync('.github/workflows/production-candidate.yml', 'utf8');
  const flow = parse(text);
  expect(Object.keys(flow.on)).toEqual(['workflow_dispatch']);
  expect(flow.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read' });
  expect(text).not.toMatch(/\bsecrets\./);
  const run = JSON.stringify(flow.jobs['gate-and-package'].steps);
  expect(run).toContain('target is not current main');
  expect(run).toContain('merge commit of exactly one merged PR');
  for (const gate of [
    'CI',
    'Database H1 + H2 + H3 + H4 + KIO-H6-01 + H5',
    'E2E H6 (browser, PWA, accessibility)',
    'OPS-02 observability and resilience gate',
    'H7 pilot readiness (edge, failure and incident drills, load, encrypted backup and restore)',
  ]) expect(run).toContain(gate);
  const build = flow.jobs['gate-and-package'].steps.find((s: { name?: string }) => s.name === 'Build production candidate');
  expect(build.env.VITE_DEPLOYMENT_TIER).toBe('production');
  expect(build.env.VITE_SUPABASE_URL).toBe('https://bypdviatamosygndeqhh.supabase.co');
  expect(build.env.VITE_SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);
  expect(JSON.stringify(build.env)).not.toMatch(/sb_secret_|service_role/);
  expect(run).toContain('npm run scan:secrets');
  expect(run).toContain('production-candidate-');
});


it('keeps the real GO-LIVE GitHub alert probe explicit, synthetic and minimally privileged', () => {
  const text = readFileSync('.github/workflows/go-live-alert-route.yml', 'utf8');
  const flow = parse(text);
  expect(flow.permissions).toEqual({ contents: 'read', issues: 'write' });
  expect(text).not.toMatch(/\bsecrets\./);
  expect(flow.jobs['real-github-alert-route'].if).toContain('go-live-alert-test');
  const job = flow.jobs['real-github-alert-route'];
  const run = JSON.stringify(job.steps);
  expect(run).toContain("environment='production'");
  expect(job.env.OPS_ALERT_ROUTE_PAGER).toContain('github-issues:');
  expect(job.env.OPS_ALERT_ROUTE_TICKET).toContain('github-issues:');
  expect(job.env.OPS_GITHUB_TOKEN).toContain('github.token');
  expect(run).toContain('APP_DOWN');
  expect(run).toContain('INVARIANT_WARNING');
  expect(run).toContain('state=closed&labels=fichaje-alert');
  expect(run).not.toMatch(/employee_id|organization_id|email|pin|password/i);
});

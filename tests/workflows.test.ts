import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

it('keeps CI unprivileged and backup manual, with no database job', () => {
  const ciText = readFileSync('.github/workflows/ci.yml', 'utf8');
  const ci = parse(ciText);
  const backup = parse(readFileSync('.github/workflows/backup.yml', 'utf8'));
  expect(ci.permissions).toEqual({ contents: 'read' });
  expect(ciText).not.toContain('secrets.');
  expect(Object.keys(backup.on)).toEqual(['workflow_dispatch']);
  expect(Object.keys(backup.jobs)).toEqual(['repository']);
  expect(backup.permissions).toEqual({ contents: 'read' });
  expect(backup.jobs.repository.if).toBe("github.ref == 'refs/heads/main'");
  expect(backup.jobs.repository.steps[0].with['fetch-depth']).toBe(0);
  expect(backup.jobs.repository.steps[0].with['persist-credentials']).toBe(false);
  const run = JSON.stringify(backup.jobs.repository.steps);
  expect(run).not.toMatch(/backup_database|pg_dump/);
});

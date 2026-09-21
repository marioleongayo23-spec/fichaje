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

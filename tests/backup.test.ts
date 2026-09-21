import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const script = resolve('scripts/backup_repo.sh');
const dbScript = resolve('scripts/backup_database.sh');
let temp: string;
let repo: string;
const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const backup = (env: NodeJS.ProcessEnv = {}) => spawnSync('bash', [script, join(temp, 'out')], {
  cwd: repo, encoding: 'utf8', env: { ...process.env, BACKUP_UPLOAD_DRIVE: '0', ...env },
});

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'fichaje-backup-'));
  repo = join(temp, 'repo'); mkdirSync(repo);
  git('init', '-b', 'main');
  git('config', 'user.name', 'Synthetic test'); git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'tracked.txt'), 'first\n');
  writeFileSync(join(repo, '.gitignore'), 'ignored.env\n');
  git('add', '.'); git('commit', '-m', 'first'); git('tag', 'v0');
  git('switch', '-c', 'other');
  writeFileSync(join(repo, 'branch.txt'), 'branch\n'); git('add', '.'); git('commit', '-m', 'branch');
  git('switch', 'main');
  writeFileSync(join(repo, 'tracked.txt'), 'second\n'); git('add', '.'); git('commit', '-m', 'second');
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe('recoverable repository backup', () => {
  it('restores all refs/history and exact HEAD snapshot without ignored files', () => {
    writeFileSync(join(repo, 'ignored.env'), 'synthetic-do-not-include');
    const result = backup();
    expect(result.status, result.stderr).toBe(0);
    const output = join(temp, 'out', readdirSync(join(temp, 'out'))[0]);
    const bundle = join(output, 'repository.bundle');
    expect(spawnSync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: output }).status).toBe(0);
    const restored = join(temp, 'restored.git');
    execFileSync('git', ['clone', '--mirror', bundle, restored], { stdio: 'pipe' });
    const refs = execFileSync('git', ['--git-dir', restored, 'for-each-ref', '--format=%(objectname) %(refname)'], { encoding: 'utf8' });
    expect(refs).toBe(readFileSync(join(output, 'refs.txt'), 'utf8'));
    expect(execFileSync('git', ['--git-dir', restored, 'rev-list', '--all', '--count'], { encoding: 'utf8' }).trim()).toBe('3');
    execFileSync('git', ['--git-dir', restored, 'fsck', '--full'], { stdio: 'pipe' });
    const extracted = join(temp, 'extracted'); mkdirSync(extracted);
    execFileSync('tar', ['-xzf', join(output, 'snapshot.tar.gz'), '-C', extracted]);
    expect(readFileSync(join(extracted, 'fichaje', 'tracked.txt'), 'utf8')).toBe('second\n');
    expect(readdirSync(join(extracted, 'fichaje')).sort()).toEqual(['.gitignore', 'tracked.txt']);
  });
  it('refuses tracked changes and untracked files', () => {
    writeFileSync(join(repo, 'tracked.txt'), 'dirty'); expect(backup().status).toBe(1);
    git('checkout', '--', 'tracked.txt');
    writeFileSync(join(repo, 'secret.env'), 'synthetic'); expect(backup().status).toBe(1);
  });
  it('refuses shallow history', () => {
    const shallow = join(temp, 'shallow');
    execFileSync('git', ['clone', '--depth', '1', `file://${repo}`, shallow], { stdio: 'pipe' });
    repo = shallow;
    const result = backup(); expect(result.status).toBe(1); expect(result.stderr).toContain('shallow');
  });
  it('fails closed when upload lacks configuration', () => {
    const result = backup({ BACKUP_UPLOAD_DRIVE: '1', RCLONE_CONFIG: '', RCLONE_DESTINATION: '' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('requires external');
  });
  it('propagates remote verification failure and removes partial local backup', () => {
    const bin = join(temp, 'bin'); mkdirSync(bin);
    const mock = join(bin, 'rclone');
    writeFileSync(mock, '#!/bin/sh\nif [ "$1" = check ]; then exit 9; fi\nexit 0\n', { mode: 0o700 });
    const conf = join(temp, 'rclone.conf'); writeFileSync(conf, 'synthetic');
    const result = backup({ BACKUP_UPLOAD_DRIVE: '1', RCLONE_CONFIG: conf, RCLONE_DESTINATION: 'fake:test', PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).toBe(9); expect(readdirSync(join(temp, 'out'))).toEqual([]);
  });
  it('keeps database backup disabled even with enabling-looking environment', () => {
    const bin = join(temp, 'bin'); mkdirSync(bin);
    const marker = join(temp, 'pg-dump-called');
    writeFileSync(join(bin, 'pg_dump'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const result = spawnSync('bash', [dbScript], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, ENABLE_DATABASE_BACKUP: 'true',
      DATABASE_URL: 'postgres://synthetic.invalid/db', BACKUP_UPLOAD_DRIVE: '1',
    } });
    expect(result.status).toBe(2); expect(result.stderr).toContain('disabled');
    expect(readdirSync(temp)).not.toContain('pg-dump-called');
  });
});

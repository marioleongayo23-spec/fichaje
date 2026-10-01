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

// H7: the encrypted database backup is enabled only when every precondition of
// docs/RECOVERY.md holds. Platform tools are stubbed here (they record their
// calls); the real pg_dump → age → restore chain runs in tests/integration/rec.py.
describe('H7 encrypted database backup preconditions and pipeline', () => {
  const RECIPIENT = 'age1' + 'q'.repeat(58);
  let root: string;
  let bin: string;
  let dest: string;
  let calls: string;

  const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  const run = (env: NodeJS.ProcessEnv = {}) => spawnSync('bash', [dbScript], { encoding: 'utf8', env: {
    PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: join(root, 'tmp'),
    FICHAJE_BACKUP_PGSERVICE: 'fichaje_backup', PGSERVICEFILE: join(root, 'pg_service.conf'), PGPASSFILE: join(root, 'pgpass'),
    FICHAJE_BACKUP_CA: join(root, 'ca.crt'), FICHAJE_BACKUP_AGE_RECIPIENT: RECIPIENT, FICHAJE_BACKUP_DEST: dest,
    FICHAJE_BACKUP_MIN_FREE_MB: '1', ...env } });
  const called = () => (readdirSync(root).includes('calls.log') ? readFileSync(calls, 'utf8') : '');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fichaje-dbbackup-'));
    bin = join(root, 'bin'); mkdirSync(bin); mkdirSync(join(root, 'tmp'));
    dest = join(root, 'dest'); mkdirSync(dest, { mode: 0o700 });
    calls = join(root, 'calls.log');
    writeFileSync(join(root, 'pg_service.conf'), '[fichaje_backup]\nhost=db.synthetic.invalid\ndbname=postgres\nuser=fichaje_backup\n', { mode: 0o600 });
    writeFileSync(join(root, 'pgpass'), 'db.synthetic.invalid:5432:postgres:fichaje_backup:synthetic\n', { mode: 0o600 });
    writeFileSync(join(root, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nMIIsynthetic\n-----END CERTIFICATE-----\n');
    stub('psql', `echo "psql $*" >> '${calls}'
case "$*" in *server_version_num*) echo 170006;; *schema_migrations*) echo 20260926000100;; *now*) echo 2026-09-28T08:00:00.000Z;; esac`);
    stub('pg_dump', `if [ "$1" = --version ]; then echo 'pg_dump (PostgreSQL) 17.6'; exit 0; fi
echo "pg_dump $*" >> '${calls}'; [ -n "$STUB_PG_DUMP_FAIL" ] && exit 3; printf 'PGDMP synthetic plaintext row 12345678Z\\n'`);
    // Stand-in cipher for orchestration only (real age runs in the REC drill).
    stub('age', `echo "age $*" >> '${calls}'; [ -n "$STUB_AGE_FAIL" ] && exit 4
out=''; while [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done
{ printf 'age-encryption.org/v1\\n'; tr 'A-Za-z0-9' 'N-ZA-Mn-za-m5-90-4'; } > "$out"`);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('encrypts in one stream with verify-full and leaves only ciphertext, checksum and manifest', () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    const files = readdirSync(dest).sort();
    expect(files).toHaveLength(3);
    const name = files[0].replace(/\.dump\.age$/, '');
    expect(files).toEqual([`${name}.dump.age`, `${name}.dump.age.sha256`, `${name}.manifest.json`]);
    const cipher = readFileSync(join(dest, `${name}.dump.age`), 'latin1');
    expect(cipher.startsWith('age-encryption.org/v1\n')).toBe(true);
    for (const file of files) expect(readFileSync(join(dest, file), 'latin1')).not.toMatch(/PGDMP|plaintext|12345678/);
    expect(spawnSync('sha256sum', ['--status', '-c', `${name}.dump.age.sha256`], { cwd: dest }).status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dest, `${name}.manifest.json`), 'utf8'));
    expect(manifest).toMatchObject({ schema: 'fichaje.db-backup.v1', result: 'success', encrypted: true, tls: 'verify-full',
      migration_version: '20260926000100', server_version_num: '170006', content: 'data-only', restore_test: null });
    expect(manifest.recipient_sha256).toMatch(/^[0-9a-f]{64}$/);
    const log = called();
    expect(log).toMatch(/pg_dump service=fichaje_backup sslmode=verify-full sslrootcert=\S+ca\.crt .*--format=custom --data-only/);
    expect(log).toContain('--table=public.* --table=private.* --table=auth.users --table=auth.identities');
    expect(log).toContain('--exclude-table=private.mutation_context');
    expect(log).toMatch(/age --encrypt --recipient age1q{58} --output/);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('never keeps a partial or plaintext result when pg_dump or encryption fails', () => {
    const dumpFailed = run({ STUB_PG_DUMP_FAIL: '1' });
    expect(dumpFailed.status).toBe(1); expect(dumpFailed.stderr).toContain('PG_DUMP_FAILED');
    const ageFailed = run({ STUB_AGE_FAIL: '1' });
    expect(ageFailed.status).toBe(1); expect(ageFailed.stderr).toContain('ENCRYPTION_FAILED');
    expect(readdirSync(dest)).toEqual([]);
    expect(readdirSync(join(root, 'tmp'))).toEqual([]);
  });

  it('fails closed before connecting when any precondition is missing', () => {
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ FICHAJE_BACKUP_AGE_RECIPIENT: '' }, 'FICHAJE_BACKUP_AGE_RECIPIENT is not configured'],
      [{ FICHAJE_BACKUP_CA: '' }, 'FICHAJE_BACKUP_CA is not configured'],
      [{ FICHAJE_BACKUP_DEST: '' }, 'FICHAJE_BACKUP_DEST is not configured'],
      [{ FICHAJE_BACKUP_AGE_RECIPIENT: 'age1short' }, 'not an age public key'],
      [{ SOME_VARIABLE: 'AGE-SECRET-KEY-1' + 'Q'.repeat(58) }, 'age private key is present'],
      [{ FICHAJE_BACKUP_DEST: resolve('.') }, 'owner-only (0700)'],
      [{ FICHAJE_BACKUP_MIN_FREE_MB: '999999999' }, 'not enough free space'],
    ];
    for (const [env, message] of cases) {
      const result = run(env);
      expect(result.status, message).toBe(2);
      expect(result.stderr, message).toContain(message);
    }
    writeFileSync(join(root, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n-----BEGIN PRIVATE KEY-----\n');
    expect(run().stderr).toContain('contains a private key');
    writeFileSync(join(root, 'ca.crt'), '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n');
    writeFileSync(join(root, 'pg_service.conf'), '[fichaje_backup]\nhost=x\npassword=inline\n', { mode: 0o600 });
    expect(run().stderr).toContain('passwords belong in PGPASSFILE');
    writeFileSync(join(root, 'pg_service.conf'), '[fichaje_backup]\nhost=x\n');
    execFileSync('chmod', ['644', join(root, 'pg_service.conf')]);
    expect(run().stderr).toContain('PGSERVICEFILE must be an owner-only');
    execFileSync('chmod', ['600', join(root, 'pg_service.conf')]);
    writeFileSync(join(dest, 'identity.txt'), 'AGE-SECRET-KEY-1' + 'Q'.repeat(58));
    expect(run().stderr).toContain('private key is stored in the destination');
    rmSync(join(dest, 'identity.txt'));
    execFileSync('chmod', ['755', dest]);
    expect(run().stderr).toContain('owner-only (0700)');
    execFileSync('chmod', ['700', dest]);
    stub('pg_dump', `if [ "$1" = --version ]; then echo 'pg_dump (PostgreSQL) 16.13'; exit 0; fi; echo "pg_dump $*" >> '${calls}'`);
    const old = run();
    expect(old.status).toBe(2); expect(old.stderr).toContain('older than the server');
    expect(called()).not.toContain('pg_dump service=');
    expect(readdirSync(dest)).toEqual([]);
  });

  it('refuses a restore without the private key custody rules or with an altered ciphertext', () => {
    const restore = resolve('scripts/restore_database.sh');
    expect(run().status).toBe(0);
    const name = readdirSync(dest).find((f) => f.endsWith('.manifest.json'))!.replace('.manifest.json', '');
    const identity = join(root, 'identity.txt');
    writeFileSync(identity, 'AGE-SECRET-KEY-1' + 'Q'.repeat(58), { mode: 0o600 });
    const env = (extra: NodeJS.ProcessEnv = {}) => ({ encoding: 'utf8' as const, env: { PATH: `${bin}:${process.env.PATH}`,
      FICHAJE_RESTORE_PGSERVICE: 'fichaje_backup', PGSERVICEFILE: join(root, 'pg_service.conf'), PGPASSFILE: join(root, 'pgpass'),
      FICHAJE_RESTORE_CA: join(root, 'ca.crt'), FICHAJE_RESTORE_IDENTITY: identity, FICHAJE_RESTORE_CONFIRM: 'postgres', ...extra } });
    expect(spawnSync('bash', [restore, dest, name], env({ FICHAJE_RESTORE_IDENTITY: '' })).status).toBe(2);
    execFileSync('cp', [identity, join(dest, 'key.txt')]);
    const beside = spawnSync('bash', [restore, dest, name], env({ FICHAJE_RESTORE_IDENTITY: join(dest, 'key.txt') }));
    expect(beside.status).toBe(2); expect(beside.stderr).toContain('private key is stored next to the backup');
    rmSync(join(dest, 'key.txt'));
    writeFileSync(join(dest, `${name}.dump.age`), 'age-encryption.org/v1\naltered', { flag: 'a' });
    const altered = spawnSync('bash', [restore, dest, name], env());
    expect(altered.status).toBe(1); expect(altered.stderr).toContain('CHECKSUM_MISMATCH');
    expect(called()).not.toMatch(/age --decrypt|psql service=fichaje_backup sslmode=verify-full.*current_database/);
    expect(spawnSync('bash', [restore, dest, 'not-a-backup'], env()).status).toBe(2);
  });
});


describe('GO-LIVE recovery operator helpers', () => {
  it('accepts the system CA store for managed Supabase backup', () => {
    const root = mkdtempSync(join(tmpdir(), 'fichaje-system-ca-'));
    try {
      const bin = join(root, 'bin'); mkdirSync(bin);
      const dest = join(root, 'dest'); mkdirSync(dest, { mode: 0o700 });
      const calls = join(root, 'calls.log');
      const stub = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
      writeFileSync(join(root, 'pg_service.conf'), '[fichaje_backup]\nhost=db.synthetic.invalid\ndbname=postgres\nuser=fichaje_backup\n', { mode: 0o600 });
      writeFileSync(join(root, 'pgpass'), 'db.synthetic.invalid:5432:postgres:fichaje_backup:synthetic\n', { mode: 0o600 });
      mkdirSync(join(root, 'tmp'));
      stub('psql', `echo "psql $*" >> '${calls}'\ncase "$*" in *server_version_num*) echo 170006;; *schema_migrations*) echo 20260930000200;; *now*) echo 2026-10-01T12:00:00.000Z;; esac`);
      stub('pg_dump', `if [ "$1" = --version ]; then echo 'pg_dump (PostgreSQL) 17.6'; exit 0; fi\nprintf 'PGDMP synthetic row\\n'`);
      stub('age', `out=''; while [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done; { printf 'age-encryption.org/v1\\n'; tr 'A-Za-z0-9' 'N-ZA-Mn-za-m5-90-4'; } > "$out"`);
      const result = spawnSync('bash', [dbScript], { encoding: 'utf8', env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: root, TMPDIR: join(root, 'tmp'),
        FICHAJE_BACKUP_PGSERVICE: 'fichaje_backup', PGSERVICEFILE: join(root, 'pg_service.conf'), PGPASSFILE: join(root, 'pgpass'),
        FICHAJE_BACKUP_CA: 'system', FICHAJE_BACKUP_AGE_RECIPIENT: 'age1' + 'q'.repeat(58),
        FICHAJE_BACKUP_DEST: dest, FICHAJE_BACKUP_MIN_FREE_MB: '1',
      }});
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(calls, 'utf8')).toContain('sslrootcert=system');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps bootstrap and restore drill free of hardcoded credentials and chat-visible prompts', () => {
    for (const path of ['scripts/go_live_recovery_bootstrap.sh', 'scripts/go_live_restore_drill.sh']) {
      const text = readFileSync(path, 'utf8');
      expect(spawnSync('bash', ['-n', path], { encoding: 'utf8' }).status, path).toBe(0);
      expect(text, path).not.toMatch(/sb_secret_|service_role|BEGIN PRIVATE KEY/);
      expect(text, path).not.toMatch(/(?:echo|printf)[^>\\n]*\\$\\{?(?:STAGING_ADMIN_PASSWORD|PRODUCTION_ADMIN_PASSWORD|ARCHIVE_PASSWORD|BACKUP_STAGING_PASSWORD|BACKUP_PRODUCTION_PASSWORD)\\}?[^>\\n]*(?:$|\\n)/m);
    }
    const bootstrap = readFileSync('scripts/go_live_recovery_bootstrap.sh', 'utf8');
    expect(bootstrap).toContain('read -rs STAGING_ADMIN_PASSWORD');
    expect(bootstrap).toContain('read -rs PRODUCTION_ADMIN_PASSWORD');
    expect(bootstrap).toContain('security add-generic-password');
    expect(bootstrap).toContain("select private.verify_journal_entry");
    expect(bootstrap).toContain('fichaje_backup_production');
    expect(bootstrap).toContain('FICHAJE_BACKUP_CA=system');

    const drill = readFileSync('scripts/go_live_restore_drill.sh', 'utf8');
    expect(drill).toContain('git -C "$ROOT" archive HEAD');
    expect(drill).toContain('FICHAJE_RESTORE_RESULT');
    expect(drill).toContain("select count(*) > 0 from public.time_events");
    expect(drill).toContain("bool_and(c.relrowsecurity)");
  });
});

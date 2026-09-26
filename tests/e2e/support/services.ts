// Starts the real server-only functions (H4 kiosk gateway, H5 export signer)
// on loopback with ephemeral synthetic secrets generated per run.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sql, stack } from './backend';

export const RUN_DIR = join('test-results', '.e2e-run');
export const STATE_FILE = join(RUN_DIR, 'state.json');
export const LOG_FILES = [join(RUN_DIR, 'kiosk-gateway.log'), join(RUN_DIR, 'export-link.log')];
export const KIOSK_PORT = 8765;
export const EXPORT_LINK_PORT = 8000;

async function waitFor(port: number, child: ReturnType<typeof spawn>) {
  for (let i = 0; i < 300; i++) {
    if (child.exitCode !== null) throw new Error(`service on ${port} exited`);
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: 'GET', signal: AbortSignal.timeout(1000) });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`service on ${port} unavailable`);
}

export async function startServices() {
  mkdirSync(RUN_DIR, { recursive: true });
  const { url, anon, service } = stack();
  // Identity changes are journaled (H5) in a separate database; fail fast
  // with the reproducible setup step instead of opaque 4xx/5xx later.
  if (sql("select count(*) from pg_database where datname='fichaje_recovery';") !== '1') {
    throw new Error('Recovery journal missing: run python3 tests/integration/journal_init.py after supabase db reset');
  }
  const role = `kiosk_e2e_${randomBytes(4).toString('hex')}`;
  const password = randomBytes(32).toString('hex');
  // Same shape as the H4 suite: an ephemeral login inheriting only fichaje_gateway.
  sql(`create role ${role} login inherit password '${password}'; grant fichaje_gateway to ${role};`);
  const kiosk = spawn('deno', ['run', '--allow-env', '--allow-net', '--config', 'supabase/functions/kiosk/deno.json', 'supabase/functions/kiosk/index.ts'], {
    env: { ...process.env, KIOSK_AUTH_URL: url, KIOSK_ANON_KEY: anon, KIOSK_AUTH_PROVISION_KEY: service,
      KIOSK_PEPPER: randomBytes(32).toString('base64'), KIOSK_NETWORK_SECRET: randomBytes(32).toString('base64'),
      KIOSK_DATABASE_URL: `postgres://${role}:${password}@127.0.0.1:54322/postgres`, KIOSK_PORT: String(KIOSK_PORT) },
    stdio: ['ignore', openSync(LOG_FILES[0], 'w'), openSync(LOG_FILES[0], 'a')], detached: true,
  });
  const signer = spawn('deno', ['run', '--allow-env', '--allow-net', 'supabase/functions/export-link/index.ts'], {
    env: { ...process.env, SUPABASE_URL: url, SUPABASE_ANON_KEY: anon, SUPABASE_SERVICE_ROLE_KEY: service },
    stdio: ['ignore', openSync(LOG_FILES[1], 'w'), openSync(LOG_FILES[1], 'a')], detached: true,
  });
  writeFileSync(STATE_FILE, JSON.stringify({ role, pids: [kiosk.pid, signer.pid] }));
  await waitFor(KIOSK_PORT, kiosk);
  await waitFor(EXPORT_LINK_PORT, signer);
}

export function stopServices() {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { role: string; pids: number[] };
  for (const pid of state.pids) {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  try { sql(`drop role if exists ${state.role};`); } catch { /* stack already stopped */ }
}

export function serviceLogs(): string {
  return LOG_FILES.filter(existsSync).map((file) => readFileSync(file, 'utf8')).join('\n');
}

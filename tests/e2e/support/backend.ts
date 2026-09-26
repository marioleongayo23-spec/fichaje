// Real local backend for browser tests: Supabase Auth/PostgREST/Storage and
// PostgreSQL started by the Supabase CLI. Only synthetic, ephemeral accounts.
// Service credentials stay in this Node process; they never reach the browser.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export interface StackStatus { url: string; publishable: string; service: string; anon: string }
let cached: StackStatus | null = null;

export function stack(): StackStatus {
  if (cached) return cached;
  const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString());
  if (!['http://127.0.0.1:54321', 'http://localhost:54321'].includes(status.API_URL)) throw new Error('Local stack only');
  cached = { url: status.API_URL, publishable: status.PUBLISHABLE_KEY, service: status.SERVICE_ROLE_KEY, anon: status.ANON_KEY };
  return cached;
}

export const DB_CONTAINER = 'supabase_db_fichaje-h1';
export const DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

export function sql(query: string): string {
  return execFileSync('docker', ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt'],
    { input: query, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
}

export async function api(path: string, options: { token?: string; body?: unknown; method?: string } = {}): Promise<{ status: number; data: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { anon, url } = stack();
  const response = await fetch(url + path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers: { apikey: anon, Authorization: `Bearer ${options.token ?? anon}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, data: text ? JSON.parse(text) : null };
}

export async function rpc(name: string, token: string, args: Record<string, unknown>) {
  return api(`/rest/v1/rpc/${name}`, { token, body: args });
}

export interface Account { id: string; email: string; password: string; token: string }

export async function signIn(email: string, password: string): Promise<string> {
  const { status, data } = await api('/auth/v1/token?grant_type=password', { body: { email, password } });
  if (status !== 200) throw new Error(`sign-in failed: ${status}`);
  return data.access_token;
}

export async function createAccount(label: string): Promise<Account> {
  const { service } = stack();
  const email = `${label}-${randomBytes(6).toString('hex')}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const { status, data } = await api('/auth/v1/admin/users', { token: service, body: { email, password, email_confirm: true } });
  if (status !== 200 && status !== 201) throw new Error(`account create failed: ${status}`);
  return { id: data.id, email, password, token: await signIn(email, password) };
}

async function ok(name: string, token: string, args: Record<string, unknown>) {
  const { status, data } = await rpc(name, token, args);
  if (status !== 200) throw new Error(`${name} failed: ${status} ${JSON.stringify(data?.message ?? data)}`);
  return data;
}

export interface Member extends Account { membership: string; employee?: string }

export async function createOrganization(name: string): Promise<{ org: string; owner: Member }> {
  const org = randomUUID();
  const owner = await createAccount('owner');
  sql(`select private.bootstrap_organization('${org}','${name.replace(/'/g, "''")}','${owner.id}','${randomUUID()}');`);
  const membership = sql(`select id from public.memberships where organization_id='${org}' and auth_user_id='${owner.id}';`);
  return { org, owner: { ...owner, membership } };
}

export async function invite(org: string, issuer: Account, email: string, role: 'ADMIN' | 'EMPLOYEE'): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await ok('create_invitation', issuer.token, { p_organization_id: org, p_request_id: randomUUID(), p_email: email, p_role: role,
    p_token_hash: createHash('sha256').update(token).digest('hex') });
  return token;
}

export async function addMember(org: string, issuer: Account, role: 'ADMIN' | 'EMPLOYEE', account?: Account): Promise<Member> {
  const user = account ?? await createAccount(role.toLowerCase());
  const token = await invite(org, issuer, user.email, role);
  const receipt = await ok('accept_invitation', user.token, { p_organization_id: org, p_request_id: randomUUID(), p_token: token });
  return { ...user, membership: receipt.id };
}

export async function createEmployee(org: string, manager: Account, options: { membership?: string | null; name?: string; code?: string } = {}) {
  const id = randomUUID();
  const code = options.code ?? `E${randomBytes(4).toString('hex')}`;
  await ok('manage_employee', manager.token, { p_organization_id: org, p_request_id: randomUUID(), p_employee_id: id, p_expected_version: 0,
    p_code: code, p_display_name: options.name ?? 'Persona sintética', p_membership_id: options.membership ?? null, p_active: true });
  return { id, code };
}

export async function createPolicy(org: string, manager: Account, timezone = 'Europe/Madrid', breaks = false): Promise<string> {
  return (await ok('create_work_policy', manager.token, { p_organization_id: org, p_request_id: randomUUID(), p_timezone: timezone, p_break_counts_as_work: breaks })).id;
}

export async function assignPolicy(org: string, manager: Account, employee: string, policy: string) {
  await ok('assign_work_policy', manager.token, { p_organization_id: org, p_request_id: randomUUID(), p_employee_id: employee, p_policy_id: policy });
}

export async function clock(org: string, user: Account, employee: string, action: string, version: number) {
  return ok('record_time_event', user.token, { p_organization_id: org, p_request_id: randomUUID(), p_employee_id: employee, p_action: action, p_expected_version: version });
}

export function eventCount(org: string, employee: string): number {
  return Number(sql(`select count(*) from public.time_events where organization_id='${org}' and employee_id='${employee}';`));
}
export function stateVersion(org: string, employee: string): number {
  return Number(sql(`select version from private.employee_state where organization_id='${org}' and employee_id='${employee}';`));
}

// A tenant with OWNER, two ADMINs and an EMPLOYEE (all linked to employee
// records with an assigned policy) plus one employee without e-mail (kiosk).
export async function scenario(name = `Empresa sintética ${randomBytes(3).toString('hex')}`) {
  const { org, owner } = await createOrganization(name);
  const admin = await addMember(org, owner, 'ADMIN');
  const admin2 = await addMember(org, owner, 'ADMIN');
  const employee = await addMember(org, owner, 'EMPLOYEE');
  const policy = await createPolicy(org, owner);
  for (const [member, label] of [[owner, 'Olga Propietaria'], [admin, 'Adrián Administrador'], [admin2, 'Alba Administradora'], [employee, 'Elena Empleada']] as const) {
    member.employee = (await createEmployee(org, owner, { membership: member.membership, name: label })).id;
    await assignPolicy(org, owner, member.employee, policy);
  }
  const kiosk = await createEmployee(org, owner, { name: 'Kiko Sin Correo' });
  await assignPolicy(org, owner, kiosk.id, policy);
  return { org, name, owner, admin, admin2, employee, policy, kiosk };
}

export function runExportWorker(): string {
  const { url, service } = stack();
  return execFileSync('python3', ['scripts/export_worker.py', '--local-only'], {
    env: { ...process.env, EXPORT_DATABASE_URL: DB_URL, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: service },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).toString();
}

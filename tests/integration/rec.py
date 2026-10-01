"""H7 REC-01..03: encrypted PostgreSQL backup, loss and isolated restore, for real.

Local ephemeral infrastructure only, synthetic data only. Phases (REC-02 records
real wall-clock instants):
  A. Source = local Supabase stack with TLS enabled from a drill CA (verify-full),
     a dedicated read-only backup login (BYPASSRLS, read-only, TLS-only in
     pg_hba) and the recovery journal archive in a SEPARATE PostgreSQL instance
     reached by dblink over verify-full TLS (independent persistence).
  B. Synthetic activity in two tenants through the real paths (RPC, edge, gateway,
     signer, offline worker, corrections decided by an independent manager).
  C. backup_database.sh: pg_dump 17.6 (pinned client image) | age → private
     destination; the host only holds the age recipient; the identity lives in a
     separate custody directory.
  D. After the backup: fichajes (not journaled: lost, measured as RPO) and
     journaled changes (deactivation, revocation, hold, release, later hold,
     purge) that must survive through the independent journal.
  E. Reconciliation against the live source, then the synthetic failure: the
     source environment is destroyed (containers and volumes).
  F. Repository restored from a bundle into an empty directory; a fresh empty
     Supabase started from that checkout (migrations, functions, triggers, RLS).
  G. REC-03 negatives on the empty target (wrong/missing key, altered and
     truncated ciphertext: nothing restored), then restore_database.sh.
  H. Journal replay (idempotent) and validation before reopening: exact data,
     RLS/cross-tenant, Auth (logins, old sessions), Storage, immutability,
     sessions, idempotency, kiosk (same pepper), exports, invariants, canary.
  I. REC-02 report; plaintext residue and leak scans.
  J. PREPARED unresolved when the instance is lost → recovery BLOCKED.
"""
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from h7_support import (ROOT, KioskAdmin, Processes, Suite, canary_mod, functions_env, http, http_json, kiosk_employee,  # noqa: E402
                        leak_scan, make_tenant, reset_opslog, secret_b64, stack, start_edge, start_functions, uid, wait_http)
from recovery_archive import ARCHIVE_SCHEMA  # noqa: E402
import psycopg  # noqa: E402
from psycopg import sql  # noqa: E402
import alerts  # noqa: E402
import invariants  # noqa: E402
import jobs  # noqa: E402
import recovery_journal  # noqa: E402

PG_IMAGE = 'postgres:17.6@sha256:00bc86618629af00d2937fdc5a5d63db3ff8450acf52f0636ec813c7f4902929'
APP_CONTAINER = 'supabase_db_fichaje-h1'
SUPABASE_NETWORK = 'supabase_network_fichaje-h1'
JOURNAL = 'fichaje-rec-journal'
JOURNAL_NETWORK = 'fichaje-rec-net'
JOURNAL_PORT = 55432
TLS = '/etc/ssl/fichaje'
OPERATOR = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
KIOSK_PORT, EXPORT_PORT, EDGE_PORT = 8768, 8004, 8791

suite = Suite('h7-rec')
check = suite.check
reset_opslog(suite.scratch / 'ops-events.jsonl')
T: dict[str, float] = {}
drill_log = open(suite.scratch / 'drill-commands.log', 'ab')


def run(command: list[str], *, env: dict | None = None, cwd: Path = ROOT, input: bytes | None = None, ok=(0,),
        log: bool = True) -> subprocess.CompletedProcess:
    """Runs a tool; its output goes to a private drill log (leak-scanned at the end), never to stdout.
    log=False for tools that print local credentials by design (the Supabase CLI status output)."""
    result = subprocess.run(command, cwd=cwd, env=env, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if log:
        drill_log.write(result.stdout + result.stderr)
        drill_log.flush()
    if result.returncode not in ok:
        raise AssertionError(f'command failed ({result.returncode}): {Path(command[0]).name} {command[1] if len(command) > 1 else ""}')
    return result


def sql_admin(statement: str, container: str = APP_CONTAINER, user: str = 'supabase_admin', db: str = 'postgres') -> str:
    return run(['docker', 'exec', '-i', container, 'psql', '-U', user, '-d', db, '-v', 'ON_ERROR_STOP=1', '-XAtq'],
               input=statement.encode()).stdout.decode().strip()


def one(query: str, params=(), dsn: str = OPERATOR):
    with psycopg.connect(dsn) as connection:
        return connection.execute(query, params).fetchone()[0]


def private_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    os.chmod(path, 0o700)
    return path


def private_file(path: Path, text: str) -> Path:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(text)
    return path


# --- A. certificates, pinned client tools, TLS and the independent journal ---------------------------
def make_ca(directory: Path, name: str) -> tuple[Path, Path]:
    key, cert = directory / f'{name}.key', directory / f'{name}.crt'
    run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', f'/CN=Fichaje H7 drill {name}',
         '-keyout', str(key), '-out', str(cert)])
    os.chmod(key, 0o600)
    return key, cert


def make_server_cert(directory: Path, ca_key: Path, ca_cert: Path) -> tuple[Path, Path]:
    key, csr, cert = directory / 'server.key', directory / 'server.csr', directory / 'server.crt'
    ext = private_file(directory / 'san.ext', f'subjectAltName=DNS:localhost,DNS:{APP_CONTAINER},DNS:{JOURNAL},IP:127.0.0.1\n'
                       'extendedKeyUsage=serverAuth\n')
    run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', f'/CN={APP_CONTAINER}', '-keyout', str(key), '-out', str(csr)])
    run(['openssl', 'x509', '-req', '-in', str(csr), '-CA', str(ca_cert), '-CAkey', str(ca_key), '-CAcreateserial', '-days', '2',
         '-extfile', str(ext), '-out', str(cert)])
    os.chmod(key, 0o600)
    return key, cert


def client_tools(bin_dir: Path, mount: Path) -> None:
    """pg_dump/psql/pg_restore 17.6 from the pinned official image (the host client is older)."""
    private_dir(bin_dir)
    for tool in ('pg_dump', 'psql', 'pg_restore'):
        (bin_dir / tool).write_text(f'''#!/bin/bash
exec docker run --rm -i --network host -e PGSERVICEFILE -e PGPASSFILE -e PGCONNECT_TIMEOUT \\
  -v "{mount}:{mount}:ro" {PG_IMAGE} {tool} "$@"
''')
        os.chmod(bin_dir / tool, 0o700)


def install_tls(container: str, owner: str, ca: Path, cert: Path, key: Path, superuser: str, hba_lines: list[str]) -> None:
    run(['docker', 'exec', '-u', 'root', container, 'mkdir', '-p', TLS])
    for source, name in ((ca, 'ca.crt'), (cert, 'server.crt'), (key, 'server.key')):
        run(['docker', 'cp', str(source), f'{container}:{TLS}/{name}'])
    run(['docker', 'exec', '-u', 'root', container, 'sh', '-c',
         f'chown {owner} {TLS}/* && chmod 644 {TLS}/ca.crt {TLS}/server.crt && chmod 600 {TLS}/server.key'])
    hba = sql_admin('show hba_file', container, superuser)
    lines = '\\n'.join(hba_lines)
    run(['docker', 'exec', '-u', 'root', container, 'sh', '-c', f'tmp=$(mktemp); printf "{lines}\\n" > "$tmp"; cat "$1" >> "$tmp"; cat "$tmp" > "$1"; rm "$tmp"',
         'hba', hba])
    sql_admin(f"alter system set ssl = 'on'; alter system set ssl_cert_file = '{TLS}/server.crt'; "
              f"alter system set ssl_key_file = '{TLS}/server.key'; select pg_reload_conf();", container, superuser)
    for _ in range(40):
        if sql_admin('show ssl', container, superuser) == 'on':
            return
        time.sleep(0.25)
    raise AssertionError('TLS not enabled')


def start_journal(certs: dict, admin_password: str, connection_password: str) -> str:
    run(['docker', 'rm', '-f', JOURNAL], ok=(0, 1))
    run(['docker', 'network', 'create', JOURNAL_NETWORK], ok=(0, 1))
    run(['docker', 'run', '-d', '--name', JOURNAL, '--network', JOURNAL_NETWORK, '-p', f'127.0.0.1:{JOURNAL_PORT}:5432',
         '-e', f'POSTGRES_PASSWORD={admin_password}', PG_IMAGE])
    for _ in range(120):
        if run(['docker', 'exec', JOURNAL, 'pg_isready', '-U', 'postgres'], ok=(0, 1, 2)).returncode == 0:
            break
        time.sleep(0.5)
    time.sleep(2)
    install_tls(JOURNAL, 'postgres:postgres', certs['ca'], certs['cert'], certs['key'], 'postgres',
                ['hostssl fichaje_recovery fichaje_archive_connection all scram-sha-256',
                 'host fichaje_recovery fichaje_archive_connection all reject'])
    admin = f'host=127.0.0.1 port={JOURNAL_PORT} user=postgres password={admin_password} sslmode=verify-full sslrootcert={certs["ca"]}'
    with psycopg.connect(admin + ' dbname=postgres', autocommit=True) as c:
        c.execute('create database fichaje_recovery')
        c.execute(sql.SQL('create role fichaje_archive_connection login noinherit password {}').format(sql.Literal(connection_password)))
        c.execute('create role fichaje_archive_writer nologin noinherit nobypassrls')
    with psycopg.connect(admin + ' dbname=fichaje_recovery') as c:
        c.execute(ARCHIVE_SCHEMA)
    return admin + ' dbname=fichaje_recovery'


def wire_journal(connection_password: str, ca: Path) -> None:
    """dblink from the app database to the separate archive, verify-full TLS."""
    run(['docker', 'network', 'connect', SUPABASE_NETWORK, JOURNAL], ok=(0, 1))
    sql_admin('grant usage on foreign data wrapper dblink_fdw to postgres')
    with psycopg.connect(OPERATOR) as c:
        c.execute(f"""create server fichaje_recovery foreign data wrapper dblink_fdw options(host '{JOURNAL}', port '5432',
          dbname 'fichaje_recovery', sslmode 'verify-full', sslrootcert '{TLS}/ca.crt')""")
        c.execute('grant usage on foreign server fichaje_recovery to fichaje_journal')
        c.execute(sql.SQL('create user mapping for fichaje_journal server fichaje_recovery options(user {},password {})').format(
            sql.Literal('fichaje_archive_connection'), sql.Literal(connection_password)))


def supabase(action: str, workdir: Path) -> None:
    """Same registry fallback as the CI workflows (ghcr → ECR → Docker Hub)."""
    extra = ['-x', 'realtime,imgproxy,edge-runtime,logflare,vector,supavisor'] if action == 'start' else ['--no-backup']
    registries = [os.environ.get('SUPABASE_INTERNAL_IMAGE_REGISTRY'), 'public.ecr.aws', 'docker.io']
    for registry in registries:
        env = {**os.environ, **({'SUPABASE_INTERNAL_IMAGE_REGISTRY': registry} if registry else {})}
        if run(['supabase', action, *extra, '--workdir', str(workdir)], env=env, ok=(0, 1), log=False).returncode == 0:
            return
        time.sleep(5)
    raise AssertionError(f'supabase {action} failed')


def fixture_history(tenant: dict) -> dict:
    """Historic, coherent, purgeable synthetic employee (privileged fixture in the ephemeral DB, as H5)."""
    employee = uid()
    canary_mod.Provisioner(api, S['service'], OPERATOR, None).rpc('manage_employee', tenant['owner']['token'], {
        'p_organization_id': tenant['org'], 'p_request_id': uid(), 'p_employee_id': employee, 'p_expected_version': 0,
        'p_code': 'hist-' + secrets.token_hex(4), 'p_display_name': 'Histórico sintético', 'p_membership_id': None, 'p_active': True})
    session = uid()
    with psycopg.connect(OPERATOR) as c:
        c.execute("""insert into public.work_sessions(id,organization_id,employee_id,policy_id,timezone,created_at)
          values(%s,%s,%s,%s,'Europe/Madrid','2020-01-10 08:00+00')""", (session, tenant['org'], employee, tenant['policy']))
        for seq, action, at in ((1, 'CLOCK_IN', '2020-01-10 08:00+00'), (2, 'CLOCK_OUT', '2020-01-10 16:00+00')):
            c.execute("""insert into public.time_events(organization_id,employee_id,session_id,sequence,event_type,server_at,
              actor_membership_id,source,request_id) values(%s,%s,%s,%s,%s,%s,%s,'WEB',%s)""",
                      (tenant['org'], employee, session, seq, action, at, tenant['owner']['membership'], uid()))
        c.execute("""update private.employee_state set version=2,last_sequence=2,last_event_at='2020-01-10 16:00+00'
          where employee_id=%s""", (employee,))
    return {'employee': employee, 'session': session}


def offline(query: str, params=()):
    with psycopg.connect(OPERATOR) as c:
        c.execute('set local role fichaje_retention_operator')
        return c.execute(query, params).fetchone()[0]


def labour_rows() -> dict:
    tables = [('public.time_events', 'id'), ('public.work_sessions', 'id'), ('public.event_adjustments', 'id'), ('public.correction_decisions', 'id'),
              ('public.correction_requests', 'id'), ('public.audit_log', 'id'), ('private.idempotency_records', 'key'), ('public.employees', 'id'),
              ('public.memberships', 'id'), ('public.organizations', 'id'), ('private.legal_holds', 'id'), ('private.employee_state', 'employee_id'),
              ('private.kiosk_credentials', 'employee_id'), ('private.kiosk_devices', 'id'), ('public.hour_classifications', 'id')]
    out = {}
    with psycopg.connect(OPERATOR) as c:
        for table, key in tables:
            for k, digest in c.execute(f'select t.{key}::text, md5(row_to_json(t)::text) from {table} t').fetchall():
                out[(table, k)] = digest
        for k, digest in c.execute('select id::text, md5(encrypted_password || coalesce(email,\'\')) from auth.users').fetchall():
            out[('auth.users', k)] = digest
    return out


def main() -> None:
    global S, api
    secrets_dir = private_dir(suite.scratch / 'custody-operator')      # connection files (operator custody)
    key_custody = private_dir(suite.scratch / 'custody-age-key')        # age identity: never on the backup host path
    destination = private_dir(suite.scratch / 'backup-destination')     # private backup destination
    work = private_dir(suite.scratch / 'backup-work')
    bin_dir = suite.scratch / 'bin'
    client_tools(bin_dir, secrets_dir)
    ca_key, ca = make_ca(secrets_dir, 'ca')
    _, rogue_ca = make_ca(secrets_dir, 'rogue')
    server_key, server_cert = make_server_cert(secrets_dir, ca_key, ca)
    certs = {'ca': ca, 'cert': server_cert, 'key': server_key}
    run(['age-keygen', '-o', str(key_custody / 'identity.txt')])
    os.chmod(key_custody / 'identity.txt', 0o600)
    recipient = run(['age-keygen', '-y', str(key_custody / 'identity.txt')]).stdout.decode().strip()
    check(recipient.startswith('age1') and 'AGE-SECRET-KEY' not in recipient, 'REC key custody: only the public recipient leaves the custody directory')

    # Fresh source environment from this checkout.
    run(['supabase', 'db', 'reset', '--local', '--no-seed'], log=False)
    S = stack()
    api = canary_mod.Api(S['url'], S['anon'])
    suite.remember(S['service'])
    archive_admin, archive_conn = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    backup_password = secrets.token_urlsafe(24)
    suite.remember(archive_admin, archive_conn, backup_password)
    install_tls(APP_CONTAINER, 'postgres:postgres', ca, server_cert, server_key, 'supabase_admin',
                ['hostssl postgres fichaje_backup_rec all scram-sha-256', 'host postgres fichaje_backup_rec all reject'])
    archive = start_journal(certs, archive_admin, archive_conn)
    wire_journal(archive_conn, ca)
    sql_admin("set password_encryption='scram-sha-256'; "
              f"create role fichaje_backup_rec login bypassrls connection limit 3 password '{backup_password}'; "
              'grant pg_read_all_data to fichaje_backup_rec; alter role fichaje_backup_rec set default_transaction_read_only = on;')
    private_file(secrets_dir / 'pg_service.conf', '[fichaje_backup]\nhost=127.0.0.1\nport=54322\ndbname=postgres\nuser=fichaje_backup_rec\n'
                 '[fichaje_restore]\nhost=127.0.0.1\nport=54322\ndbname=postgres\nuser=postgres\n')
    private_file(secrets_dir / 'pgpass', f'127.0.0.1:54322:postgres:fichaje_backup_rec:{backup_password}\n127.0.0.1:54322:postgres:postgres:postgres\n')
    # verify-full is enforced by the server for this login and by the client for the drill CA.
    tls = f'host=127.0.0.1 port=54322 dbname=postgres user=fichaje_backup_rec password={backup_password}'
    for mode, label in ((f'sslmode=disable', 'without TLS'), (f'sslmode=verify-full sslrootcert={rogue_ca}', 'with an untrusted CA'),
                        (f'sslmode=verify-full sslrootcert={ca} host=localhost hostaddr=127.0.0.1', None)):
        try:
            with psycopg.connect(f'{tls} {mode}', connect_timeout=5) as c:
                ok = c.execute('select current_setting(\'transaction_read_only\')').fetchone()[0] == 'on'
            check(label is None and ok, 'REC backup login: verify-full TLS with the drill CA, read-only session')
        except psycopg.OperationalError:
            check(label is not None, f'REC backup login refused {label}')

    # --- B. synthetic activity ---------------------------------------------------------------------
    processes = Processes(suite.scratch / 'logs')
    pepper, network, ingress = secret_b64(), secret_b64(), secret_b64()
    suite.remember(pepper, network, ingress)
    gateway_login = secrets.token_urlsafe(24)
    suite.remember(gateway_login)

    def serve(source: Path, tag: str) -> str:
        sql_admin(f"drop role if exists kiosk_rec; set password_encryption='scram-sha-256'; create role kiosk_rec login inherit password "
                  f"'{gateway_login}'; grant fichaje_gateway to kiosk_rec;")
        env = functions_env(S, f'postgresql://kiosk_rec:{gateway_login}@127.0.0.1:54322/postgres', pepper, network, ingress, 'h7-rec')
        start_functions(processes, env, KIOSK_PORT, EXPORT_PORT, source / 'supabase' / 'functions', tag)
        dist = suite.scratch / f'dist-{tag}'
        if not dist.exists():
            if source != ROOT:
                (source / 'node_modules').symlink_to(ROOT / 'node_modules')
            subprocess.run(['npm', 'run', 'build', '--', '--outDir', str(dist), '--emptyOutDir'], cwd=source, check=True,
                           env={**os.environ, 'VITE_SUPABASE_URL': S['url'], 'VITE_SUPABASE_PUBLISHABLE_KEY': S['publishable'], 'FICHAJE_RELEASE': 'h7-rec'},
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return start_edge(processes, suite.scratch, dist, EDGE_PORT, {'FICHAJE_KIOSK_UPSTREAM': f'http://127.0.0.1:{KIOSK_PORT}',
                          'FICHAJE_EXPORT_LINK_UPSTREAM': f'http://127.0.0.1:{EXPORT_PORT}', 'FICHAJE_INGRESS_SECRET': ingress}, source, tag)

    edge = serve(ROOT, 'source')
    prov = canary_mod.Provisioner(api, S['service'], OPERATOR, None)
    admin_kiosk = KioskAdmin(edge + '/gateway/kiosk')
    A = make_tenant(suite, api, prov, workers=3, admins=1)
    B = make_tenant(suite, api, prov, workers=1, timezone_name='Atlantic/Canary')
    receipts = {}
    for tenant in (A, B):
        for worker in tenant['workers']:
            version = 0
            for action in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'):
                request_id = uid()
                args = {'p_organization_id': tenant['org'], 'p_request_id': request_id, 'p_employee_id': worker['employee'],
                        'p_action': action, 'p_expected_version': version}
                receipts[(worker['employee'], action)] = (args, api.rpc('record_time_event', worker['token'], args, f'clock.{action}', True, request_id))
                version += 1
    w1, w2, w3 = A['workers']
    out_args, out_receipt = receipts[(w1['employee'], 'CLOCK_OUT')]
    _, break_end = receipts[(w1['employee'], 'BREAK_END')]
    t_end = datetime.fromisoformat(break_end['server_at'].replace('Z', '+00:00'))
    t_out = datetime.fromisoformat(out_receipt['server_at'].replace('Z', '+00:00'))
    corrected_at = (t_end + (t_out - t_end) / 2).isoformat()
    submitted = prov.rpc('submit_correction', w1['token'], {'p_organization_id': A['org'], 'p_request_id': uid(), 'p_employee_id': w1['employee'],
                         'p_base_version': 4, 'p_reason': 'Motivo sintético H7', 'p_operations': [{'operation': 'REPLACE',
                         'target_event_id': out_receipt['event_id'], 'session_id': out_receipt['session_id'], 'event_type': 'CLOCK_OUT',
                         'effective_at': corrected_at, 'timezone': 'Europe/Madrid', 'ordinal': 4}]})
    admin = A['admins'][0]
    prov.rpc('decide_correction', admin['token'], {'p_organization_id': A['org'], 'p_request_id': uid(),
             'p_correction_request_id': submitted['correction_request_id'], 'p_decision': 'APPROVE', 'p_reason': 'Revisión sintética'})
    device = admin_kiosk.provision(api, A['owner']['token'], A['org'])
    suite.remember(device['password'])
    kiosk_person = kiosk_employee(suite, prov, admin_kiosk, A)
    gw = canary_mod.Gateway(edge + '/gateway/kiosk')
    for action in ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT'):
        offer = gw.post('authenticate', device['token'], {'organization_id': A['org'], 'device_id': device['id'], 'code': kiosk_person['code'],
                        'pin': kiosk_person['pin']}, 'kiosk.authenticate', None, mutation=False)
        challenge = next(c for c in offer['challenges'] if c['action'] == action)
        gw.post('record', device['token'], {'organization_id': A['org'], 'device_id': device['id'], 'request_id': challenge['request_id'],
                'challenge': challenge['challenge'], 'action': action, 'expected_version': offer['version']}, f'clock.{action}', challenge['request_id'], True)
    today = datetime.now(timezone.utc).date().isoformat()
    old_export = prov.rpc('request_export', w2['token'], {'p_organization_id': A['org'], 'p_request_id': uid(), 'p_employee_id': None,
                          'p_start': today, 'p_end': today, 'p_timezone': 'Europe/Madrid'})
    check(jobs.export_job(OPERATOR, S['url'], S['service'])['outcome'] == 'success', 'REC source: export generated by the offline worker')
    historic = fixture_history(A)
    check(one('select count(*) from public.time_events where session_id=%s', (historic['session'],)) == 2, 'REC source: historic purgeable evidence present')

    # --- C. encrypted backup --------------------------------------------------------------------------
    recovery_journal.reconcile(OPERATOR, archive)
    before_backup = labour_rows()
    env = {'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'HOME': str(suite.scratch), 'TMPDIR': str(work),
           'FICHAJE_BACKUP_PGSERVICE': 'fichaje_backup', 'PGSERVICEFILE': str(secrets_dir / 'pg_service.conf'),
           'PGPASSFILE': str(secrets_dir / 'pgpass'), 'FICHAJE_BACKUP_CA': str(ca), 'FICHAJE_BACKUP_AGE_RECIPIENT': recipient,
           'FICHAJE_BACKUP_DEST': str(destination), 'FICHAJE_BACKUP_MIN_FREE_MB': '64'}
    refused = run(['bash', 'scripts/backup_database.sh'], env={**env, 'FICHAJE_BACKUP_CA': str(rogue_ca)}, ok=(1,))
    check(b'CONNECTION_FAILED' in refused.stderr and not any(destination.iterdir()), 'REC backup with an untrusted CA refused: nothing produced')
    T['backup_started'] = time.time()
    run(['bash', 'scripts/backup_database.sh'], env=env)
    T['backup_completed'] = time.time()
    manifests = sorted(destination.glob('*.manifest.json'))
    check(len(manifests) == 1, 'REC encrypted backup produced (ciphertext, checksum, manifest)')
    manifest = json.loads(manifests[0].read_text())
    name = manifest['name']
    cipher = destination / f'{name}.dump.age'
    check(manifest['encrypted'] and manifest['tls'] == 'verify-full' and cipher.read_bytes()[:21] == b'age-encryption.org/v1'
          and b'PGDMP' not in cipher.read_bytes(), 'REC ciphertext is age-encrypted; no plaintext dump in the destination')
    snapshot = datetime.fromisoformat(manifest['snapshot_not_before'].replace('Z', '+00:00')).timestamp()
    T['backup_snapshot'] = snapshot

    # --- D. after the backup: lost fichajes and journaled changes that must survive ---------------------
    time.sleep(2)
    lost = api.rpc('record_time_event', w1['token'], {'p_organization_id': A['org'], 'p_request_id': uid(), 'p_employee_id': w1['employee'],
                   'p_action': 'CLOCK_IN', 'p_expected_version': 5}, 'clock.CLOCK_IN', True, None)
    manage = lambda token, args: prov.rpc('manage_employee', token, args)  # noqa: E731
    w3_row = api.get(f'/rest/v1/employees?select=code,display_name,version&id=eq.{w3["employee"]}', A['owner']['token'])[0]
    manage(A['owner']['token'], {'p_organization_id': A['org'], 'p_request_id': uid(), 'p_employee_id': w3['employee'],
           'p_expected_version': w3_row['version'], 'p_code': w3_row['code'], 'p_display_name': w3_row['display_name'],
           'p_membership_id': w3['membership'], 'p_active': False})
    membership = api.get(f'/rest/v1/memberships?select=version,role&id=eq.{w2["membership"]}', A['owner']['token'])[0]
    prov.rpc('manage_membership', A['owner']['token'], {'p_organization_id': A['org'], 'p_request_id': uid(), 'p_membership_id': w2['membership'],
             'p_expected_version': membership['version'], 'p_role': membership['role'], 'p_active': False})
    org_hold = offline('select private.record_legal_hold(%s,%s,%s,%s)', (A['org'], None, 'Retención sintética', 'SYN-REC-HOLD'))
    offline('select private.record_legal_hold(%s,%s,%s,%s,%s)', (A['org'], None, 'Liberación sintética', 'SYN-REC-RELEASE', org_hold))
    offline('select private.record_legal_hold(%s,%s,%s,%s)', (A['org'], w1['employee'], 'Retención posterior sintética', 'SYN-REC-LATER'))
    offline('select private.purge_labour(%s,%s,%s,%s,%s)', (A['org'], historic['employee'], '2020-01-01', '2024-01-31 23:00+00', 'SYN-REC-PURGE'))
    check(one('select count(*) from public.time_events where session_id=%s', (historic['session'],)) == 0, 'REC after backup: authorized purge applied')
    recovery_journal.reconcile(OPERATOR, archive)
    source_id = one('select id from private.journal_source')
    check(len(recovery_journal.committed_entries(archive, source_id)) >= 5, 'REC journal: post-backup deactivation, revocation, hold, release and purge COMMITTED')

    # --- E. synthetic failure: the source environment is destroyed -------------------------------------
    processes.stop()
    run(['docker', 'network', 'disconnect', SUPABASE_NETWORK, JOURNAL], ok=(0, 1))
    T['failure'] = time.time()
    supabase('stop', ROOT)
    try:
        psycopg.connect(OPERATOR, connect_timeout=3).close()
        source_alive = True
    except psycopg.OperationalError:
        source_alive = False
    check(not source_alive, 'REC failure injected: the source database, Auth, REST and Storage are gone (containers and volumes)')

    # --- F. repository from its bundle into an empty directory, fresh isolated environment --------------
    T['restore_started'] = time.time()
    head = run(['git', 'rev-parse', 'HEAD']).stdout.decode().strip()
    bundle = suite.scratch / 'repository.bundle'
    run(['git', 'bundle', 'create', str(bundle), 'HEAD'])
    run(['git', 'bundle', 'verify', str(bundle)])
    restored = suite.scratch / 'restored-repo'
    run(['git', 'clone', '-q', str(bundle), str(restored)], cwd=suite.scratch)
    run(['git', '-C', str(restored), 'checkout', '-q', head])
    check(run(['git', '-C', str(restored), 'rev-parse', 'HEAD^{tree}']).stdout == run(['git', 'rev-parse', 'HEAD^{tree}']).stdout,
          'REC-01 repository restored from its bundle into an empty directory (same tree)')
    supabase('start', restored)
    S = stack()
    api = canary_mod.Api(S['url'], S['anon'])
    check(one('select coalesce(max(version),\'\') from supabase_migrations.schema_migrations') == manifest['migration_version']
          and one('select count(*) from public.organizations') == 0, 'REC-01 fresh empty environment with the restored migrations (functions, triggers, RLS)')
    install_tls(APP_CONTAINER, 'postgres:postgres', ca, server_cert, server_key, 'supabase_admin', [])
    wire_journal(archive_conn, ca)

    # --- G. REC-03 negatives on the empty target, then the real restore ---------------------------------
    renv = {'PATH': env['PATH'], 'HOME': str(suite.scratch), 'FICHAJE_RESTORE_PGSERVICE': 'fichaje_restore',
            'PGSERVICEFILE': env['PGSERVICEFILE'], 'PGPASSFILE': env['PGPASSFILE'], 'FICHAJE_RESTORE_CA': str(ca),
            'FICHAJE_RESTORE_IDENTITY': str(key_custody / 'identity.txt'), 'FICHAJE_RESTORE_CONFIRM': 'postgres',
            'FICHAJE_RESTORE_RESULT': str(destination / f'{name}.restore.json')}
    wrong = private_dir(suite.scratch / 'wrong-key')
    run(['age-keygen', '-o', str(wrong / 'identity.txt')])
    os.chmod(wrong / 'identity.txt', 0o600)
    result = run(['bash', 'scripts/restore_database.sh', str(destination), name], env={**renv, 'FICHAJE_RESTORE_IDENTITY': str(wrong / 'identity.txt'),
                 'FICHAJE_RESTORE_RESULT': ''}, ok=(1,))
    check(b'DECRYPTION_FAILED' in result.stderr and one('select count(*) from public.organizations') == 0,
          'REC-03 wrong private key: decryption fails, nothing restored')
    result = run(['bash', 'scripts/restore_database.sh', str(destination), name], env={**renv, 'FICHAJE_RESTORE_IDENTITY': ''}, ok=(2,))
    check(b'FICHAJE_RESTORE_IDENTITY is not configured' in result.stderr, 'REC-03 without the private key the restore is refused')
    run(['age', '--decrypt', str(cipher)], ok=(1,))
    check(True, 'REC-03 age refuses to decrypt without an identity')
    tampered = private_dir(suite.scratch / 'tampered')
    for suffix in ('.dump.age', '.dump.age.sha256', '.manifest.json'):
        shutil.copy2(destination / f'{name}{suffix}', tampered / f'{name}{suffix}')
    raw = bytearray((tampered / f'{name}.dump.age').read_bytes())
    raw[len(raw) // 2] ^= 0xFF
    (tampered / f'{name}.dump.age').write_bytes(bytes(raw))
    result = run(['bash', 'scripts/restore_database.sh', str(tampered), name], env={**renv, 'FICHAJE_RESTORE_RESULT': ''}, ok=(1,))
    check(b'CHECKSUM_MISMATCH' in result.stderr, 'REC-03 altered ciphertext refused before decryption')
    truncated = bytes(cipher.read_bytes()[: len(cipher.read_bytes()) * 2 // 3])
    (tampered / f'{name}.dump.age').write_bytes(truncated)
    digest = hashlib.sha256(truncated).hexdigest()
    (tampered / f'{name}.dump.age.sha256').write_text(f'{digest}  {name}.dump.age\n')
    forged = json.loads((tampered / f'{name}.manifest.json').read_text())
    forged['ciphertext_sha256'] = digest
    (tampered / f'{name}.manifest.json').write_text(json.dumps(forged, separators=(',', ':')))
    result = run(['bash', 'scripts/restore_database.sh', str(tampered), name], env={**renv, 'FICHAJE_RESTORE_RESULT': ''}, ok=(1,))
    check(b'DECRYPTION_FAILED' in result.stderr and one('select count(*) from public.organizations') == 0,
          'REC-03 truncated ciphertext with forged checksum: authenticated decryption fails, nothing restored')
    run(['bash', 'scripts/restore_database.sh', str(destination), name], env=renv)
    T['restore_completed'] = time.time()
    after_restore = labour_rows()
    check(after_restore == before_backup, 'REC-01 restore reproduces the backed-up state byte for byte (labour, audit, receipts, identity, Auth)')
    check(one('select count(*) from private.mutation_context') == 0, 'REC-01 transaction-bound capability contexts are never restored')

    # --- H. journal replay, then validation before reopening -------------------------------------------
    replayed = recovery_journal.replay(OPERATOR, archive)
    check(replayed >= 5 and recovery_journal.replay(OPERATOR, archive) == 0, 'REC-01 journal replay applied the post-backup changes once (idempotent)')
    T['replay_completed'] = time.time()
    check(one('select count(*) from public.time_events where session_id=%s', (historic['session'],)) == 0, 'REC-01 purge re-applied: purged evidence not restored')
    check(not one('select active from public.employees where id=%s', (w3['employee'],)), 'REC-01 deactivation (baja) re-applied')
    check(not one('select active from public.memberships where id=%s', (w2['membership'],)), 'REC-01 membership revocation re-applied')
    check(not offline('select private.active_legal_hold(%s,%s)', (A['org'], None)) and offline('select private.active_legal_hold(%s,%s)', (A['org'], w1['employee'])),
          'REC-01 hold, release and later hold re-applied in order')
    check(one('select count(*) from public.time_events where request_id=%s', (lost['request_id'],)) == 0, 'REC-02 the post-backup fichaje is lost (measured RPO)')
    tokens = {}
    for person in (w1, B['workers'][0], A['owner'], admin):
        tokens[person['email']] = api.token(person['email'], person['password'])
    check(len(tokens) == 4, 'REC-01 Auth restored: synthetic users sign in with their passwords')
    status, _, _ = http_json('GET', S['url'] + '/auth/v1/user', {'apikey': S['anon'], 'Authorization': 'Bearer ' + w1['token']})
    check(status in (401, 403), 'REC-01 sessions are not restored: a pre-loss access token is refused by Auth')
    t_w1 = tokens[w1['email']]
    foreign = api.get(f'/rest/v1/time_events?select=id&organization_id=eq.{B["org"]}', t_w1)
    own = api.get(f'/rest/v1/time_events?select=id&employee_id=eq.{w1["employee"]}', t_w1)
    check(foreign == [] and len(own) == 4, 'REC-01 RLS: own evidence visible, other tenant invisible')
    w2_token = api.token(w2['email'], w2['password'])
    status, _, _ = http_json('POST', S['url'] + '/rest/v1/rpc/get_employee_state', {'apikey': S['anon'], 'Authorization': 'Bearer ' + w2_token},
                             {'p_organization_id': A['org'], 'p_employee_id': w2['employee']})
    check(status in (401, 403), 'REC-01 the revoked membership stays revoked after restore + replay')
    replay_receipt = api.rpc('record_time_event', t_w1, out_args, 'clock.CLOCK_OUT', True, out_args['p_request_id'])
    check(replay_receipt == out_receipt, 'REC-01 idempotency: a pre-backup request returns its original receipt, no new event')
    try:
        with psycopg.connect(OPERATOR) as c:
            c.execute("update public.time_events set server_at=server_at where id=%s", (out_receipt['event_id'],))
        immutable = False
    except psycopg.Error:
        immutable = True
    check(immutable, 'REC-01 immutability triggers active again after the restore')
    state = api.rpc('get_employee_state', t_w1, {'p_organization_id': A['org'], 'p_employee_id': w1['employee']}, 'rpc.get_employee_state', False)
    check(state['state'] == 'OUT' and state['version'] == 5, 'REC-01 session state consistent with the backup point (lost CLOCK_IN not invented)')
    status, _, _ = http('GET', S['url'] + '/storage/v1/object/public/fichaje-evidence/x.zip')
    check(status >= 400 and one("select public from storage.buckets where id='fichaje-evidence'") is False,
          'REC-01 Storage: evidence bucket recreated private, no public access')
    edge = serve(restored, 'restored')
    check(wait_http(edge + '/gateway/kiosk/health/ready', 60), 'REC-01 functions and edge from the restored repository are up')
    gw = canary_mod.Gateway(edge + '/gateway/kiosk')
    device_token = api.token(device['email'], device['password'])
    offer = gw.post('authenticate', device_token, {'organization_id': A['org'], 'device_id': device['id'], 'code': kiosk_person['code'],
                    'pin': kiosk_person['pin']}, 'kiosk.authenticate', None, mutation=False)
    check(offer['state'] == 'OUT' and offer['actions'] == ['CLOCK_IN'], 'REC-01 kiosk: restored device and PIN work with the pepper from secret custody')
    status, _, _ = http_json('POST', edge + '/gateway/export-link', {'Authorization': 'Bearer ' + tokens[admin['email']]},
                             {'organization_id': A['org'], 'job_id': old_export['job_id']})
    check(status == 403, 'REC-01 pre-loss temporary export objects are not restored (24 h files): link refused')
    fresh = prov.rpc('request_export', tokens[admin['email']], {'p_organization_id': A['org'], 'p_request_id': uid(), 'p_employee_id': None,
                     'p_start': today, 'p_end': today, 'p_timezone': 'Europe/Madrid'})
    check(jobs.export_job(OPERATOR, S['url'], S['service'])['outcome'] == 'success', 'REC-01 exports: a new export is generated after restore')
    status, _, link = http_json('POST', edge + '/gateway/export-link', {'Authorization': 'Bearer ' + tokens[admin['email']]},
                                {'organization_id': A['org'], 'job_id': fresh['job_id']})
    check(status == 200 and http('GET', link['url'])[2][:2] == b'PK', 'REC-01 exports: signed link and download work after restore')
    suite.remember(link['url'])
    monitor_password = secrets.token_urlsafe(24)
    suite.remember(monitor_password)
    sql_admin(f"create role ops_monitor_rec login inherit password '{monitor_password}'; grant fichaje_ops_monitor to ops_monitor_rec;")
    summary = invariants.summary(f'postgresql://ops_monitor_rec:{monitor_password}@127.0.0.1:54322/postgres')
    critical = sorted(x['invariant'] for x in summary['summary'] if x['severity'] == 'CRITICAL' and x['findings'] > 0)
    check(critical == [], 'REC-01 read-only invariants: no CRITICAL finding after restore + replay')
    canary_prov = canary_mod.Provisioner(api, S['service'], OPERATOR, gw)
    canary_state = canary_prov.provision()
    suite.remember(canary_state['tenant']['owner']['password'], canary_state['tenant']['worker']['password'],
                   canary_state['kiosk']['device_password'], canary_state['kiosk']['pin'], canary_state['kiosk']['private_key'])
    report = canary_mod.Canary(canary_state, api, gw, provisioner=canary_prov).run()
    check(report['status'] == 'PASS', 'REC-01 synthetic canary (web + kiosk) PASS on the restored environment before reopening')
    T['available'] = time.time()
    import backup_monitor as monitor
    db_status = monitor.evaluate_db_manifest(monitor.load_db_manifest(str(manifests[0]), str(destination / f'{name}.restore.json')),
                                             datetime.now(timezone.utc))
    check(db_status['status'] == 'OK' and db_status['restore_tested'], 'RES-04/REC backup monitor: OK only with the restore of this very backup')

    # --- I. REC-02 report and REC-03 residue/leak scans ------------------------------------------------
    rec02 = {'backup_snapshot_utc': datetime.fromtimestamp(T['backup_snapshot'], timezone.utc).isoformat(timespec='seconds'),
             'failure_utc': datetime.fromtimestamp(T['failure'], timezone.utc).isoformat(timespec='seconds'),
             'rpo_window_s': round(T['failure'] - T['backup_snapshot'], 1),
             'lost_fichajes': 1, 'max_observed_loss_s': round(T['failure'] - T['backup_snapshot'], 1),
             'backup_duration_s': round(T['backup_completed'] - T['backup_started'], 1),
             'restore_start_after_failure_s': round(T['restore_started'] - T['failure'], 1),
             'environment_and_restore_s': round(T['restore_completed'] - T['restore_started'], 1),
             'replay_s': round(T['replay_completed'] - T['restore_completed'], 1),
             'validation_s': round(T['available'] - T['replay_completed'], 1),
             'rto_s': round(T['available'] - T['failure'], 1), 'rpo_target_h': 24, 'rto_target_h': 8}
    check(rec02['rpo_window_s'] <= 24 * 3600 and rec02['rto_s'] <= 8 * 3600, 'REC-02 measured RPO/RTO within the pilot objectives (not an SLA)')
    (suite.scratch / 'rec02.json').write_text(json.dumps(rec02, sort_keys=True))
    residue = []
    for base in (suite.scratch, Path(os.environ.get('TMPDIR', '/tmp'))):
        for path in base.rglob('*'):
            if path.is_file() and not path.is_symlink() and 'node_modules' not in path.parts and path.stat().st_size < 50_000_000:
                head_bytes = path.read_bytes()[:5]
                if head_bytes == b'PGDMP':
                    residue.append(path.name)
    check(residue == [], 'REC-03 no plaintext dump (PGDMP) anywhere in the drill directories or the temporary directory')
    check(not any(work.iterdir()), 'REC-03 backup work directory left empty')
    processes.stop()
    findings = leak_scan(suite, [suite.scratch / 'logs', suite.scratch / 'ops-events.jsonl', suite.scratch / 'rec02.json',
                                 suite.scratch / 'drill-commands.log', destination / f'{name}.manifest.json', destination / f'{name}.restore.json'])
    for source, rule in findings:
        print(f'LEAK_PATTERN {rule} in {Path(source).name}', file=sys.stderr)
    check(findings == [], 'REC-03 no secret, key, credential, PII or record data in logs, manifests or reports')

    # --- J. PREPARED unresolved when the instance is lost → BLOCKED ------------------------------------
    holder = psycopg.connect(OPERATOR)
    holder.execute('update public.employees set active=false,version=version+1 where id=%s', (w1['employee'],))
    run(['docker', 'network', 'disconnect', SUPABASE_NETWORK, JOURNAL], ok=(0, 1))
    run(['docker', 'kill', APP_CONTAINER], ok=(0, 1))
    try:
        holder.close()
    except psycopg.Error:
        pass
    supabase('stop', restored)
    try:
        recovery_journal.committed_entries(archive, source_id)   # the restored instance kept the backed-up source id
        blocked = False
    except RuntimeError as error:
        blocked = str(error) == 'RECOVERY_BLOCKED_UNRESOLVED_JOURNAL'
    check(blocked, 'REC journal: a PREPARED entry whose instance is lost blocks recovery (never presumed committed or aborted)')
    engine = alerts.AlertEngine(suite.scratch / 'alerts.json', {'pager': [], 'ticket': []}, 'ci')
    fired = engine.process({'journal': {'status': 'BLOCKED'}})
    check([n['alert'] for n in fired] == ['RECOVERY_JOURNAL_BLOCKED'] and fired[0]['severity'] == 'CRITICAL',
          'REC journal BLOCKED raises the CRITICAL RECOVERY_JOURNAL_BLOCKED alert')
    print(json.dumps({'rec': 'PASS', 'checks': suite.count, 'rec02': rec02}, sort_keys=True))


def cleanup() -> None:
    subprocess.run(['docker', 'rm', '-f', JOURNAL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['docker', 'network', 'rm', JOURNAL_NETWORK], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # Leave a clean local stack from this checkout for the other suites.
    subprocess.run(['supabase', 'stop', '--no-backup'], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['supabase', 'start', '-x', 'realtime,imgproxy,edge-runtime,logflare,vector,supavisor'], cwd=ROOT,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    S: dict = {}
    api = None
    status = 0
    try:
        main()
    except BaseException as error:
        import traceback
        frames = [f'{Path(f.filename).name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__)]
        print(f'FAIL rec after {suite.count} checks: {type(error).__name__} at {" > ".join(frames[-4:])}', file=sys.stderr)
        if isinstance(error, AssertionError):
            print(f'assertion: {error}', file=sys.stderr)
        status = 1
    finally:
        cleanup()
    sys.exit(status)

"""OPS-02 real observability and resilience suite.

Local ephemeral Supabase (Auth, PostgREST, Storage, PostgreSQL), the real
kiosk gateway and export-link signer in releases built from this commit, and
synthetic tenants only. Every fault is real for the system under test (HTTP/TCP
hops, stopped/paused containers, broken release artifacts, privileged drift in
the ephemeral database); detection always goes through the operational code.
Nothing here writes to production, uses real data or uploads artefacts.
"""
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'ops'))
sys.path.insert(0, str(ROOT / 'scripts'))
os.environ['OPS_FAULT_INJECTION'] = '1'
os.environ['FICHAJE_RELEASE'] = 'ops02-suite'
import psycopg  # noqa: E402
import opslib  # noqa: E402
import metrics  # noqa: E402
import retry  # noqa: E402
import alerts  # noqa: E402
import leakscan  # noqa: E402
import health  # noqa: E402
import canary as canary_mod  # noqa: E402
import invariants  # noqa: E402
import rebuild_projection  # noqa: E402
import jobs  # noqa: E402
import backup_monitor  # noqa: E402
import release_gate  # noqa: E402
import faults  # noqa: E402

status = json.loads(subprocess.check_output(['supabase', 'status', '-o', 'json'], stderr=subprocess.DEVNULL))
URL = status['API_URL']
assert URL in ('http://127.0.0.1:54321', 'http://localhost:54321'), 'Local stack only'
ANON, SERVICE, PUBLISHABLE = status['ANON_KEY'], status['SERVICE_ROLE_KEY'], status['PUBLISHABLE_KEY']
OPERATOR = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
ARCHIVE = 'postgresql://postgres:postgres@127.0.0.1:54322/fichaje_recovery'
CONTRACT = opslib.CONTRACT
scratch = Path(tempfile.mkdtemp(prefix='ops02-'))
opslib.LOG.path = str(scratch / 'events.jsonl')
checks = 0
known: list[str] = []          # synthetic sensitive values that must never leak
reports: dict[str, object] = {}  # every report the suite produced (leak-scanned at the end)


def check(condition, label):
    global checks
    assert condition, label
    checks += 1
    print(f'ok {checks} - {label}', flush=True)


def rows(query, params=()):
    with psycopg.connect(OPERATOR) as connection:
        return connection.execute(query, params).fetchall()


def one(query, params=()):
    return rows(query, params)[0][0]


def uid():
    return str(uuid.uuid4())


def login(name: str, role: str) -> str:
    password = secrets.token_hex(24)
    with psycopg.connect(OPERATOR, autocommit=True) as connection:
        connection.execute(f'drop role if exists {name}')
        connection.execute(psycopg.sql.SQL('create role {} login inherit password {}').format(psycopg.sql.Identifier(name), psycopg.sql.Literal(password)))
        connection.execute(psycopg.sql.SQL('grant {} to {}').format(psycopg.sql.Identifier(role), psycopg.sql.Identifier(name)))
    known.append(password)
    return f'postgresql://{name}:{password}@127.0.0.1:54322/postgres'


def history(org=None):
    """Byte-level digest of immutable labour evidence (and receipts), per tenant or global."""
    where = 'where t.organization_id=%(o)s' if org else ''
    audit = f"{where + ' and' if org else 'where'} t.action<>'rebuild_projection'"
    tables = [('public.time_events', 'id', where), ('public.work_sessions', 'id', where), ('public.event_adjustments', 'id', where),
              ('public.correction_decisions', 'id', where), ('public.correction_requests', 'id', where),
              ('public.audit_log', 'id', audit), ('private.idempotency_records', 'key', where)]
    parts = ",".join(f"(select coalesce(string_agg(row_to_json(t)::text,'' order by t.{key}),'') from {table} t {cond})" for table, key, cond in tables)
    return one(f'select md5(concat_ws(chr(1),{parts}))', {'o': org} if org else {})


def projection(employee):
    return one('select row_to_json(s)::text from private.employee_state s where employee_id=%s', (employee,))


api = canary_mod.Api(URL, ANON)
prov = canary_mod.Provisioner(api, SERVICE, OPERATOR, None)


def make_tenant(workers=1, admin=False, timezone_name='Europe/Madrid'):
    owner = prov.account('owner')
    org = uid()
    owner['membership'] = prov.bootstrap(org, owner['id'])
    owner['token'] = api.token(owner['email'], owner['password'])
    known.extend([owner['email'], owner['password'], org])
    policy = prov.rpc('create_work_policy', owner['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_timezone': timezone_name,
                      'p_break_counts_as_work': False})['id']
    people = []
    for role in ['EMPLOYEE'] * workers + (['ADMIN'] if admin else []):
        person = prov.account(role.lower())
        token = secrets.token_hex(32)
        prov.rpc('create_invitation', owner['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_email': person['email'], 'p_role': role,
                 'p_token_hash': hashlib.sha256(token.encode()).hexdigest()})
        person['token'] = api.token(person['email'], person['password'])
        person['membership'] = prov.rpc('accept_invitation', person['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_token': token})['id']
        if role == 'EMPLOYEE':
            person['employee'], person['code'] = prov.employee(org, owner['token'], person['membership'], policy)
            known.extend([person['employee'], person['code']])
        known.extend([person['email'], person['password']])
        people.append(person)
    return {'org': org, 'owner': owner, 'policy': policy, 'workers': [p for p in people if 'employee' in p],
            'admin': next((p for p in people if 'employee' not in p), None)}


def unassigned_worker(tenant):
    """A synthetic EMPLOYEE linked to an employee record without any work policy."""
    person = prov.account('employee')
    token = secrets.token_hex(32)
    prov.rpc('create_invitation', tenant['owner']['token'], {'p_organization_id': tenant['org'], 'p_request_id': uid(), 'p_email': person['email'],
             'p_role': 'EMPLOYEE', 'p_token_hash': hashlib.sha256(token.encode()).hexdigest()})
    person['token'] = api.token(person['email'], person['password'])
    person['membership'] = prov.rpc('accept_invitation', person['token'], {'p_organization_id': tenant['org'], 'p_request_id': uid(), 'p_token': token})['id']
    person['employee'], code = uid(), 'ops-' + secrets.token_hex(4)
    prov.rpc('manage_employee', tenant['owner']['token'], {'p_organization_id': tenant['org'], 'p_request_id': uid(), 'p_employee_id': person['employee'],
             'p_expected_version': 0, 'p_code': code, 'p_display_name': 'Sin horario sintético', 'p_membership_id': person['membership'], 'p_active': True})
    known.extend([person['email'], person['password'], person['employee'], code, 'Sin horario sintético'])
    return person


def clock(tenant, worker, action, version, request_id=None):
    request_id = request_id or uid()
    return api.rpc('record_time_event', worker['token'], {'p_organization_id': tenant['org'], 'p_request_id': request_id,
                   'p_employee_id': worker['employee'], 'p_action': action, 'p_expected_version': version}, f'clock.{action}', True, request_id)


def cycle(tenant, worker, start=0):
    receipts = []
    for n, action in enumerate(('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')):
        receipts.append(clock(tenant, worker, action, start + n))
    return receipts


def main():
    # --- OBS-07: technical identities are least privilege ---------------------------------
    monitor_dsn = login('ops_monitor_ci', 'fichaje_ops_monitor')
    reviewer_dsn = login('ops_reviewer_ci', 'fichaje_ops_reviewer')
    repair_dsn = login('ops_repair_ci', 'fichaje_ops_repairer')
    gateway_dsn = login('kiosk_ops_ci', 'fichaje_gateway')
    check(one("""select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace, unnest(%s::text[]) r(name)
        where n.nspname in ('public','private','auth','storage') and c.relkind in ('r','v','m','p')
        and (has_table_privilege(r.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') or has_any_column_privilege(r.name,c.oid,'SELECT,INSERT,UPDATE'))""",
              (['ops_monitor_ci', 'ops_reviewer_ci', 'ops_repair_ci'],)) == 0, 'OBS-07 operator logins inherit no table or column privilege')
    check(one("""select count(*) from pg_roles where rolname like 'fichaje\\_ops%%' and (rolcanlogin or rolsuper or rolbypassrls or rolinherit)""") == 0,
          'OBS-07 technical OPS roles are NOLOGIN, NOINHERIT and NOBYPASSRLS')
    check(one("select has_function_privilege('ops_monitor_ci','private.ops_invariant_summary()','EXECUTE') and not has_function_privilege('ops_monitor_ci','private.ops_invariant_findings(uuid)','EXECUTE') and not has_function_privilege('ops_monitor_ci','private.ops_rebuild_projection(uuid,uuid,uuid,text)','EXECUTE')"),
          'OBS-07 routine monitor sees aggregates only and cannot review or repair')

    sink = alerts.TestSink()
    sink.__enter__()
    routes = {'pager': [alerts.Notifier(sink.url + '/pager')], 'ticket': [alerts.Notifier(sink.url + '/ticket')]}

    def engine(name):
        return alerts.AlertEngine(scratch / f'alerts-{name}.json', routes, 'ci')

    # --- RES-02 infrastructure: an immutable healthy release R1 ------------------------------
    pepper, network = base64.b64encode(secrets.token_bytes(32)).decode(), base64.b64encode(secrets.token_bytes(32)).decode()
    known.extend([pepper, network, SERVICE])
    runtime = {'KIOSK_AUTH_URL': URL, 'KIOSK_ANON_KEY': ANON, 'KIOSK_AUTH_PROVISION_KEY': SERVICE, 'KIOSK_DATABASE_URL': gateway_dsn,
               'KIOSK_PEPPER': pepper, 'KIOSK_NETWORK_SECRET': network, 'SUPABASE_URL': URL, 'SUPABASE_ANON_KEY': ANON,
               'SUPABASE_SERVICE_ROLE_KEY': SERVICE}
    deployer = release_gate.LocalDeployer(scratch / 'deploy', runtime, {'VITE_SUPABASE_URL': URL, 'VITE_SUPABASE_PUBLISHABLE_KEY': PUBLISHABLE},
                                          {'app': 4180, 'kiosk': 8775, 'export_link': 8011})
    commit = os.environ.get('GITHUB_SHA') or subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    try:
        deployer.build('ops02-r1', commit)
        live = deployer.deploy('ops02-r1')
        check(all(live.values()), 'RES-02 release R1 built from this commit and deployed (app, gateway, signer live)')
        app = deployer.app_url
        targets = health.Targets(app_url=app, api_url=URL, anon_key=ANON, db_dsn=monitor_dsn,
                                 kiosk_url=app + '/gateway/kiosk', export_link_url=app + '/gateway/export-link')
        run_suite(deployer, targets, engine, sink, monitor_dsn, reviewer_dsn, repair_dsn, commit)
    finally:
        deployer.stop()
        sink.__exit__()
        with psycopg.connect(OPERATOR, autocommit=True) as connection:
            for name in ('ops_monitor_ci', 'ops_reviewer_ci', 'ops_repair_ci', 'kiosk_ops_ci'):
                connection.execute(f'drop role if exists {name}')


def run_suite(deployer, targets, engine, sink, monitor_dsn, reviewer_dsn, repair_dsn, commit):
    app = deployer.app_url
    events_before = one('select count(*) from public.time_events')
    # --- OBS-03: healthy dependencies ----------------------------------------------------------
    report = health.run(targets)
    reports['health-up'] = report
    check(report['status'] == 'UP' and set(report['checks']) == set(CONTRACT['checks'])
          and all(c['status'] == 'UP' for c in report['checks'].values()), 'OBS-03 application, API, Auth, PostgreSQL, kiosk gateway and signer UP')
    text = json.dumps(report)
    check(not any(v in text for v in (URL, '127.0.0.1', 'localhost', ANON, SERVICE, 'postgresql://', ':54322', 'http')),
          'OBS-03 health report exposes no URL, host, key or DSN')
    _, raw, _ = opslib.http_raw('GET', app + '/gateway/kiosk/health/live', {}, 5)
    check(json.loads(raw) == {'status': 'UP'}, 'OBS-03 kiosk gateway liveness returns only a status')
    _, raw, headers = opslib.http_raw('GET', app + '/gateway/kiosk/health/ready', {}, 5)
    check(json.loads(raw) == {'status': 'UP', 'checks': {'auth': 'UP', 'database': 'UP'}} and 'no-store' in headers.get('cache-control', ''),
          'OBS-03 kiosk readiness: Auth and PostgreSQL, statuses only, no-store')
    _, raw, _ = opslib.http_raw('GET', app + '/gateway/export-link/health/ready', {}, 5)
    check(json.loads(raw) == {'status': 'UP', 'checks': {'auth': 'UP', 'rest': 'UP', 'storage': 'UP'}}, 'OBS-03 signer readiness: Auth, PostgREST and Storage')
    check(one('select count(*) from public.time_events') == events_before, 'OBS-03 health checks create no fichaje and need no data')

    # --- OBS-04: synthetic canary, both channels --------------------------------------------
    gateway = canary_mod.Gateway(app + '/gateway/kiosk')
    prov.gateway = gateway
    state = prov.provision()
    opslib.write_private(scratch / 'canary-state.json', json.dumps(state))
    known.extend([state['tenant']['owner']['email'], state['tenant']['owner']['password'], state['tenant']['worker']['email'],
                  state['tenant']['worker']['password'], state['kiosk']['device_email'], state['kiosk']['device_password'],
                  state['kiosk']['pin'], state['kiosk']['code'], state['tenant']['employee'], state['kiosk']['employee'],
                  state['tenant']['org'], state['control']['org'], state['control']['employee'], 'Canary sintético'])
    can = canary_mod.Canary(state, api, gateway, provisioner=prov)
    first = can.run()
    reports['canary-1'] = first
    check(first['status'] == 'PASS' and first['channels']['web']['status'] == 'PASS' and first['channels']['kiosk']['status'] == 'PASS',
          'OBS-04 OUT→CLOCK_IN→WORKING→BREAK_START→PAUSED→BREAK_END→WORKING→CLOCK_OUT→OUT on web and kiosk')
    second = can.run()
    check(second['status'] == 'PASS' and not second['channels']['web']['rotated'], 'OBS-04 canary is repeatable')
    web, kiosk = state['tenant']['employee'], state['kiosk']['employee']
    check(one('select count(*) from public.time_events where employee_id=%s', (web,)) == 8
          and one('select count(*) from public.time_events where employee_id=%s', (kiosk,)) == 8, 'OBS-04 synthetic history is kept, never deleted')
    check(one("select name from public.organizations where id=%s", (state['tenant']['org'],)) == 'Canary sintético OPS-02'
          and one("select count(*) from public.memberships m join auth.users u on u.id=m.auth_user_id where u.email=%s", (state['tenant']['worker']['email'],)) == 1,
          'OBS-04 canary identities belong only to the synthetic tenant')
    step_ids = [s['request_id'] for c in (first, second) for ch in c['channels'].values() for s in ch['steps']]
    check(len(step_ids) == 16 and one('select count(*) from public.audit_log where request_id = any(%s::uuid[])', (step_ids,)) == 16
          and one('select count(*) from public.time_events where request_id = any(%s::uuid[])', (step_ids,)) == 16,
          'OBS-04 each step audited exactly once and one event per request despite retries')
    kiosk_audit = one("select count(*) from public.audit_log where request_id = any(%s::uuid[]) and actor_kind='KIOSK'",
                      ([s['request_id'] for s in first['channels']['kiosk']['steps']],))
    check(kiosk_audit == 4, 'OBS-04 kiosk steps audited as KIOSK actor')
    # A previous run interrupted mid-cycle: the synthetic employee is rotated, never closed.
    clock({'org': state['tenant']['org']}, {'token': api.token(state['tenant']['worker']['email'], state['tenant']['worker']['password']), 'employee': web},
          'CLOCK_IN', 8)
    rotated = can.run(('web',))
    check(rotated['status'] == 'PASS' and rotated['channels']['web']['rotated'] and state['tenant']['employee'] != web,
          'OBS-04 interrupted synthetic cycle rotates to a fresh synthetic employee')
    check(one('select state::text from private.employee_state where employee_id=%s', (web,)) == 'WORKING'
          and one('select count(*) from public.time_events where employee_id=%s', (web,)) == 9, 'OBS-04 the open synthetic session is left open (no automatic close)')
    # Canary transition failure: the synthetic employee is deactivated by its synthetic OWNER.
    owner_token = api.token(state['tenant']['owner']['email'], state['tenant']['owner']['password'])
    current = state['tenant']['employee']
    version = api.get(f'/rest/v1/employees?select=version&id=eq.{current}', owner_token)[0]['version']
    prov.rpc('manage_employee', owner_token, {'p_organization_id': state['tenant']['org'], 'p_request_id': uid(), 'p_employee_id': current,
             'p_expected_version': version, 'p_code': 'canary-disabled-' + secrets.token_hex(3), 'p_display_name': 'Canary sintético',
             'p_membership_id': state['tenant']['membership'], 'p_active': False})
    canary_engine = engine('canary')
    broken = can.run(('web',))
    reports['canary-broken'] = broken
    check(broken['status'] == 'FAIL' and broken['channels']['web']['error_class'] == 'FORBIDDEN', 'OBS-04 canary transition failure detected (FORBIDDEN)')
    fired = canary_engine.process({'canary': broken})
    check([n['alert'] for n in fired] == ['CANARY_FAILED'] and sink.find('CANARY_FAILED', 'FIRING', channel='web')[0]['route'] == 'pager',
          'OBS-06 CANARY_FAILED routed to pager')
    prov.rpc('manage_employee', owner_token, {'p_organization_id': state['tenant']['org'], 'p_request_id': uid(), 'p_employee_id': current,
             'p_expected_version': version + 1, 'p_code': 'canary-' + secrets.token_hex(3), 'p_display_name': 'Canary sintético',
             'p_membership_id': state['tenant']['membership'], 'p_active': True})
    healed = can.run(('web',))
    resolved = canary_engine.process({'canary': healed})
    check(healed['status'] == 'PASS' and [(n['alert'], n['status']) for n in resolved] == [('CANARY_FAILED', 'RESOLVED')],
          'OBS-06 canary back to green emits RESOLVED')

    # --- RES-01: retries only with the same key and payload -----------------------------------
    t = make_tenant(workers=1)
    worker = t['workers'][0]
    proxy = faults.HttpFaultProxy(URL)
    try:
        rid = uid()
        body = json.dumps({'p_organization_id': t['org'], 'p_request_id': rid, 'p_employee_id': worker['employee'],
                           'p_action': 'CLOCK_IN', 'p_expected_version': 0}, sort_keys=True).encode()
        headers = {'apikey': ANON, 'Authorization': 'Bearer ' + worker['token']}
        post = lambda payload, _n: opslib.http_json('POST', proxy.url + '/rest/v1/rpc/record_time_event', headers, payload, 10)[1]  # noqa: E731
        policy = retry.RetryPolicy(max_attempts=3, base_delay_ms=100, max_delay_ms=200, jitter=lambda: 1.0)
        proxy.set('/rest/v1/rpc/record_time_event', 'drop_after_forward_once')
        sleeps = []
        receipt = retry.execute(retry.Operation('ops-suite', 'clock.CLOCK_IN', True, True, body, rid), post, policy, sleep=sleeps.append)
        forwarded = [h for _, path, h in proxy.forwarded if path.endswith('/record_time_event')]
        check(len(forwarded) == 2 and forwarded[0] == forwarded[1] == hashlib.sha256(body).hexdigest(),
              'RES-01 timeout after commit retried with the exact same payload and request_id')
        check(receipt['request_id'] == rid and receipt['state'] == 'WORKING' and sleeps == [0.1], 'RES-01 retry recovers the committed receipt after backoff')
        check([one('select count(*) from public.time_events where request_id=%s', (rid,)), one('select count(*) from public.audit_log where request_id=%s', (rid,)),
               one("select count(*) from private.idempotency_records where key=%s", (rid,))] == [1, 1, 1], 'RES-01 exactly one mutation, audit and receipt')
        seen = proxy.seen
        stale = json.dumps({'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': worker['employee'],
                            'p_action': 'BREAK_START', 'p_expected_version': 0}, sort_keys=True).encode()
        try:
            retry.execute(retry.Operation('ops-suite', 'clock.BREAK_START', True, True, stale, json.loads(stale)['p_request_id']), post, policy, sleep=sleeps.append)
            raise AssertionError('stale version accepted')
        except retry.NotRetryable as error:
            check(error.error_class == 'VERSION_CONFLICT' and proxy.seen - seen == 1, 'RES-01 permanent error attempted exactly once')
        proxy.set('/rest/v1/rpc/', 'status:503')
        seen, sleeps = proxy.seen, []
        breaker = retry.CircuitBreaker(failures=3, cooldown_ms=60_000)
        pending = json.dumps({'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': worker['employee'],
                              'p_action': 'BREAK_START', 'p_expected_version': 1}, sort_keys=True).encode()
        key = json.loads(pending)['p_request_id']
        try:
            retry.execute(retry.Operation('ops-suite', 'clock.BREAK_START', True, True, pending, key), post,
                          retry.RetryPolicy(max_attempts=3, base_delay_ms=100, max_delay_ms=250, jitter=lambda: 1.0), breaker, sleep=sleeps.append)
            raise AssertionError('503 accepted')
        except retry.RetryExhausted as error:
            check(error.last_class == 'UPSTREAM_5XX' and proxy.seen - seen == 3 and sleeps == [0.1, 0.2], 'RES-01 bounded attempts with exponential backoff')
        seen = proxy.seen
        try:
            retry.execute(retry.Operation('ops-suite', 'clock.BREAK_START', True, True, pending, key), post, policy, breaker, sleep=sleeps.append)
            raise AssertionError('circuit ignored')
        except retry.CircuitOpen:
            check(proxy.seen == seen and breaker.state == 'OPEN', 'RES-01 open circuit stops calling the failing dependency')
        check(one('select count(*) from public.time_events where request_id=%s', (key,)) == 0, 'RES-01 failed retries never mutated')
        proxy.clear()
        once = json.dumps({'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': worker['employee'],
                           'p_action': 'BREAK_START', 'p_expected_version': 1}, sort_keys=True).encode()
        proxy.set('/rest/v1/rpc/record_time_event', 'drop_after_forward_once')
        seen = proxy.seen
        try:
            retry.execute(retry.Operation('ops-suite', 'clock.BREAK_START', False, True, once, None), post, policy, sleep=sleeps.append)
            raise AssertionError('lost ACK hidden')
        except retry.NotRetryable as error:
            check(error.error_class == 'UNKNOWN_OUTCOME' and proxy.seen - seen == 1, 'RES-01 non-idempotent or keyless operation is never retried automatically')
        # A real client timeout while the server still commits: unknown outcome, the key is kept.
        slow = json.dumps({'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': worker['employee'],
                           'p_action': 'BREAK_END', 'p_expected_version': 2}, sort_keys=True).encode()
        slow_key = json.loads(slow)['p_request_id']
        proxy.set('/rest/v1/rpc/record_time_event', 'delay:1500')
        impatient = lambda payload, _n: opslib.http_json('POST', proxy.url + '/rest/v1/rpc/record_time_event', headers, payload, 0.5)[1]  # noqa: E731
        try:
            retry.execute(retry.Operation('ops-suite', 'clock.BREAK_END', True, True, slow, slow_key), impatient,
                          retry.RetryPolicy(max_attempts=2, base_delay_ms=100, max_delay_ms=100, jitter=lambda: 1.0))
            raise AssertionError('timeout hidden')
        except retry.RetryExhausted as error:
            check(error.last_class == 'UNKNOWN_OUTCOME' and error.unknown_outcome and error.attempts == 2,
                  'RES-01 client timeout on a mutation is an unknown outcome: retried with the same key, never a new one')
        proxy.clear()
        time.sleep(2)   # the delayed forwards reach the server after the caller gave up
        recovered = retry.execute(retry.Operation('ops-suite', 'clock.BREAK_END', True, True, slow, slow_key), post, policy, sleep=sleeps.append)
        check(recovered['request_id'] == slow_key and recovered['state'] == 'WORKING'
              and one('select count(*) from public.time_events where request_id=%s', (slow_key,)) == 1,
              'RES-01 retry with the kept key after a timeout returns the single committed event')
    finally:
        proxy.close()

    # --- OBS-02/06: POLICY_REQUIRED and CLOCK_REGRESSION through the real engine ----------
    unassigned = unassigned_worker(t)
    try:
        clock(t, unassigned, 'CLOCK_IN', 0)
        raise AssertionError('fichaje without policy accepted')
    except retry.NotRetryable as error:
        check(error.error_class == 'POLICY_REQUIRED' and one('select count(*) from public.time_events where employee_id=%s', (unassigned['employee'],)) == 0,
              'OBS-02 POLICY_REQUIRED rejected by the engine without writing')
    cr = make_tenant(workers=1)
    crw = cr['workers'][0]
    clock(cr, crw, 'CLOCK_IN', 0)
    window = len(opslib.LOG.events)
    faults.clock_regression(OPERATOR, cr['org'], crw['employee'])
    try:
        clock(cr, crw, 'BREAK_START', 1)
        raise AssertionError('clock regression accepted')
    except retry.NotRetryable as error:
        check(error.error_class == 'CLOCK_REGRESSION' and one('select count(*) from public.time_events where employee_id=%s', (crw['employee'],)) == 1,
              'OBS-02 CLOCK_REGRESSION rejected by the engine without any write')
    metric_engine = engine('metrics')
    fired = metric_engine.process({'metrics': metrics.rates(opslib.LOG.events[window:])})
    check([(n['alert'], n['labels'], n['routes']) for n in fired] == [('CLOCK_REGRESSION', {'component': 'canary'}, ['ticket'])],
          'OBS-06 CLOCK_REGRESSION metric alert routed to ticket')
    # Here the future high-water mark lives only in the projection: the checker sees drift of a derived
    # field, and the authorized rebuild from the immutable source removes it (a real NTP regression would
    # show no drift and has no data remedy).
    candidate = [c for c in rebuild_projection.check(repair_dsn, cr['org']) if c['employee_id'] == crw['employee']]
    check([(c['status'], c['fields']) for c in candidate] == [('DRIFT', ['last_event_at'])], 'OBS-05 injected high-water mark is projection drift')
    fixed = rebuild_projection.apply(repair_dsn, cr['org'], crw['employee'], 'OPS02-CI-AUTH-CLOCK')
    window = len(opslib.LOG.events)
    after_fix = clock(cr, crw, 'BREAK_START', 1)
    check(fixed['outcome'] == 'APPLIED' and after_fix['state'] == 'PAUSED'
          and [(n['alert'], n['status']) for n in metric_engine.process({'metrics': metrics.rates(opslib.LOG.events[window:])})] == [('CLOCK_REGRESSION', 'RESOLVED')],
          'OBS-06 fichaje works again after the authorized rebuild and the alert resolves')

    # --- OBS-05 + RES-03: repairable drift, alert, rebuild, resolution ---------------------
    invariant_engine = engine('invariants')
    before_all = history()
    clean = invariants.summary(monitor_dsn)
    check(not any(r['severity'] == 'CRITICAL' for r in clean['summary']), 'OBS-05 coherent synthetic history has no critical invariant')
    recorded = invariants.record(monitor_dsn)
    check(recorded['critical'] == 0 and one('select count(*) from private.ops_original_baselines') > 0, 'OBS-05 evidence run and original baselines recorded')
    check(history() == before_all, 'OBS-05 checking and recording never mutate history, audit or receipts')
    check(not [n for n in invariant_engine.process({'invariants': clean}) if n['alert'] == 'INVARIANT_CRITICAL'], 'OBS-06 no invariant alert while coherent')
    r = make_tenant(workers=1, admin=True)
    rw = r['workers'][0]
    receipts = cycle(r, rw)
    submit_reason = 'Synthetic OPS-02 correction ' + secrets.token_hex(4)
    known.append(submit_reason)
    proposal = [{'operation': 'REPLACE', 'target_event_id': receipts[3]['event_id'], 'session_id': receipts[3]['session_id'],
                 'event_type': 'CLOCK_OUT', 'effective_at': receipts[2]['server_at'], 'timezone': 'Europe/Madrid', 'ordinal': 4}]
    request = prov.rpc('submit_correction', rw['token'], {'p_organization_id': r['org'], 'p_request_id': uid(), 'p_employee_id': rw['employee'],
                       'p_base_version': 4, 'p_reason': submit_reason, 'p_operations': proposal})
    prov.rpc('decide_correction', r['admin']['token'], {'p_organization_id': r['org'], 'p_request_id': uid(),
             'p_correction_request_id': request['correction_request_id'], 'p_decision': 'APPROVE', 'p_reason': submit_reason})
    exact = projection(rw['employee'])
    invariants.record(monitor_dsn)
    tenant_history = history(r['org'])
    faults.projection_drift(OPERATOR, r['org'], rw['employee'])
    drift = invariants.summary(monitor_dsn)
    reports['invariants-drift'] = drift
    check(any(x['invariant'] == 'PROJECTION_DRIFT' and x['severity'] == 'CRITICAL' and x['findings'] == 1 for x in drift['summary']),
          'OBS-05 synthetic projection drift detected')
    fired = invariant_engine.process({'invariants': drift})
    check([(n['alert'], n['labels']) for n in fired] == [('INVARIANT_CRITICAL', {'invariant': 'PROJECTION_DRIFT'})]
          and sink.find('INVARIANT_CRITICAL', 'FIRING', invariant='PROJECTION_DRIFT')[0]['route'] == 'pager', 'OBS-06 drift alert routed to pager')
    detail = invariants.findings(reviewer_dsn, r['org'])
    check([(f['invariant'], f['subject_id'], f['detail']['repairable']) for f in detail if f['invariant'] == 'PROJECTION_DRIFT'] == [('PROJECTION_DRIFT', rw['employee'], True)],
          'OBS-05 tenant-scoped human review shows the repairable subject')
    corrupted = projection(rw['employee'])
    candidates = rebuild_projection.check(repair_dsn, r['org'])
    check([c['status'] for c in candidates if c['employee_id'] == rw['employee']] == ['DRIFT'] and projection(rw['employee']) == corrupted
          and history(r['org']) == tenant_history, 'RES-03 --check reports the drift and writes nothing')
    try:
        with psycopg.connect(repair_dsn) as connection:
            connection.execute('set transaction read only')
            connection.execute('select private.ops_rebuild_projection(%s,%s,%s,%s)', (r['org'], rw['employee'], uid(), 'READ-ONLY-PROBE'))
        raise AssertionError('write inside dry run')
    except psycopg.errors.ReadOnlySqlTransaction:
        check(True, 'RES-03 dry-run transactions are READ ONLY: a rebuild cannot run inside them')
    rebuild_id = uid()
    applied = rebuild_projection.apply(repair_dsn, r['org'], rw['employee'], 'OPS02-CI-AUTH-1', rebuild_id)
    check(applied['outcome'] == 'APPLIED' and projection(rw['employee']) == exact, 'RES-03 rebuild restores exactly the derived projection')
    check(history(r['org']) == tenant_history, 'RES-03 originals, corrections, adjustments, audit and receipts byte-for-byte unchanged')
    check(one("select count(*) from public.audit_log where action='rebuild_projection' and request_id=%s", (rebuild_id,)) == 1
          and one('select outcome from private.ops_projection_repairs where request_id=%s', (rebuild_id,)) == 'APPLIED', 'RES-03 repair audited with operational evidence')
    again = rebuild_projection.apply(repair_dsn, r['org'], rw['employee'], 'OPS02-CI-AUTH-2')
    replay = rebuild_projection.apply(repair_dsn, r['org'], rw['employee'], 'OPS02-CI-AUTH-1', rebuild_id)
    check(again['outcome'] == 'NOOP' and replay['replayed'] and replay['outcome'] == 'APPLIED' and projection(rw['employee']) == exact,
          'RES-03 second execution is a no-op and the same request replays')
    healed = invariants.summary(monitor_dsn)
    resolved = invariant_engine.process({'invariants': healed})
    check(not any(x['invariant'] == 'PROJECTION_DRIFT' for x in healed['summary'])
          and [(n['alert'], n['status']) for n in resolved] == [('INVARIANT_CRITICAL', 'RESOLVED')], 'OBS-06 invariant recovery emits RESOLVED')
    invariants.record(monitor_dsn)
    faults.tamper_original(OPERATOR, r['org'], rw['employee'], 2)
    faults.projection_drift(OPERATOR, r['org'], rw['employee'])
    tampered = projection(rw['employee'])
    blocked = rebuild_projection.apply(repair_dsn, r['org'], rw['employee'], 'OPS02-CI-AUTH-3')
    check(blocked['outcome'] == 'BLOCKED' and 'ORIGINAL_DIGEST_MISMATCH' in blocked['reasons'] and projection(rw['employee']) == tampered,
          'RES-03 incoherent immutable source blocks automatic repair and escalates')

    # --- OBS-05: each non-repairable drift detected, escalated, never "fixed" -------------------
    d3 = make_tenant(workers=1)
    cycle(d3, d3['workers'][0])
    invariants.record(monitor_dsn)
    faults.delete_original(OPERATOR, d3['org'], d3['workers'][0]['employee'], 2)
    d4, d5 = make_tenant(workers=1), make_tenant(workers=1)
    foreign_event = cycle(d5, d5['workers'][0])[0]['event_id']
    cycle(d4, d4['workers'][0])
    faults.cross_tenant_audit(OPERATOR, d4['org'], d4['owner']['id'], foreign_event)
    d6 = make_tenant(workers=1, admin=True)
    w6 = d6['workers'][0]
    first6 = cycle(d6, w6)
    rejected = prov.rpc('submit_correction', w6['token'], {'p_organization_id': d6['org'], 'p_request_id': uid(), 'p_employee_id': w6['employee'],
                        'p_base_version': 4, 'p_reason': submit_reason, 'p_operations': [{'operation': 'VOID', 'target_event_id': first6[1]['event_id'],
                                                                                          'session_id': first6[1]['session_id']}]})
    decision = prov.rpc('decide_correction', d6['admin']['token'], {'p_organization_id': d6['org'], 'p_request_id': uid(),
                        'p_correction_request_id': rejected['correction_request_id'], 'p_decision': 'REJECT', 'p_reason': submit_reason})
    with psycopg.connect(OPERATOR) as connection:
        connection.execute("""insert into public.event_adjustments(organization_id,employee_id,decision_id,target_event_id,operation,session_id,created_at)
          values(%s,%s,%s,%s,'VOID',%s,clock_timestamp())""", (d6['org'], w6['employee'], decision['decision_id'], first6[1]['event_id'], first6[1]['session_id']))
    stale = make_tenant(workers=1)
    sw = stale['workers'][0]
    with psycopg.connect(OPERATOR) as connection:
        auth_id = connection.execute('select auth_user_id from public.memberships where id=%s', (sw['membership'],)).fetchone()[0]
        session, event, rid = uid(), uid(), uid()
        connection.execute("insert into public.work_sessions(id,organization_id,employee_id,policy_id,timezone,created_at) values(%s,%s,%s,%s,'Europe/Madrid',clock_timestamp()-interval '20 hours')",
                           (session, stale['org'], sw['employee'], stale['policy']))
        connection.execute("""insert into public.time_events(id,organization_id,employee_id,session_id,sequence,event_type,server_at,actor_membership_id,source,request_id)
          values(%s,%s,%s,%s,1,'CLOCK_IN',clock_timestamp()-interval '20 hours',%s,'WEB',%s)""", (event, stale['org'], sw['employee'], session, sw['membership'], rid))
        connection.execute("""insert into public.audit_log(organization_id,actor_kind,actor_id,employee_id,action,entity_type,entity_id,request_id)
          values(%s,'USER',%s,%s,'record_time_event','time_events',%s,%s)""", (stale['org'], auth_id, sw['employee'], event, rid))
        connection.execute("""insert into private.idempotency_records(organization_id,principal_kind,principal_id,operation,key,payload_sha256,response)
          values(%s,'USER',%s,'record_time_event',%s,repeat('0',64),jsonb_build_object('event_id',%s::text))""", (stale['org'], auth_id, rid, event))
        connection.execute("""update private.employee_state set state='WORKING',open_session_id=%s,version=1,last_sequence=1,
          last_event_at=(select server_at from public.time_events where id=%s) where employee_id=%s""", (session, event, sw['employee']))
    backlog = prov.rpc('request_export', sw['token'], {'p_organization_id': stale['org'], 'p_request_id': uid(), 'p_employee_id': None,
                       'p_start': datetime.now(timezone.utc).date().isoformat(), 'p_end': datetime.now(timezone.utc).date().isoformat(), 'p_timezone': 'Europe/Madrid'})
    with psycopg.connect(OPERATOR) as connection:
        connection.execute("update private.export_jobs set created_at=created_at-interval '2 hours',expires_at=expires_at-interval '2 hours' where id=%s", (backlog['job_id'],))
    faults.disable_guard(OPERATOR, 'public.audit_log', 'audit_immutable')
    before_scan = history()
    escalated = invariants.summary(monitor_dsn)
    guard_findings = {x['invariant'] for x in escalated['summary']}
    faults.enable_guard(OPERATOR, 'public.audit_log', 'audit_immutable')
    reports['invariants-escalated'] = escalated
    by = {(x['invariant'], x['severity']) for x in escalated['summary']}
    expected = {('SEQUENCE_CONTIGUOUS', 'CRITICAL'), ('AUDIT_WITHOUT_EVENT', 'CRITICAL'), ('RECEIPT_WITHOUT_EVENT', 'CRITICAL'),
                ('TENANT_REFERENCE', 'CRITICAL'), ('CORRECTION_COHERENCE', 'CRITICAL'), ('ORIGINAL_IMMUTABLE', 'CRITICAL'),
                ('EVENT_RECEIPT', 'CRITICAL'), ('IMMUTABILITY_GUARD', 'CRITICAL'), ('OPEN_SESSION_STALE', 'WARNING'), ('EXPORT_JOB_STATE', 'WARNING')}
    check(expected <= by, 'OBS-05 deleted, altered and cross-tenant evidence, incoherent corrections, disabled guards, stale sessions and export lag all detected')
    check(history() == before_scan, 'OBS-05 the checker never mutates history while reporting drift')
    check(one("select state::text from private.employee_state where employee_id=%s", (sw['employee'],)) == 'WORKING',
          'OBS-05 stale open session reported, never closed automatically')
    fired = invariant_engine.process({'invariants': escalated})
    routed = {(n['alert'], n['labels'].get('invariant'), tuple(n['routes'])) for n in fired}
    check({('INVARIANT_CRITICAL', 'TENANT_REFERENCE', ('pager',)), ('INVARIANT_WARNING', 'OPEN_SESSION_STALE', ('ticket',)),
           ('EXPORT_BACKLOG', 'EXPORT_JOB_STATE', ('ticket',)), ('INVARIANT_CRITICAL', 'IMMUTABILITY_GUARD', ('pager',))} <= routed,
          'OBS-06 CRITICAL invariants page, WARNING invariants open tickets')
    after_guard = invariants.summary(monitor_dsn)
    check('IMMUTABILITY_GUARD' in guard_findings and not any(x['invariant'] == 'IMMUTABILITY_GUARD' for x in after_guard['summary']),
          'OBS-05 re-enabled guard clears the structural finding')

    # --- JOBS: failure, retry, recovery ------------------------------------------------------
    job_engine = engine('jobs')
    storage = faults.HttpFaultProxy(URL)
    try:
        storage.set('/storage/', 'status:503')
        failed = jobs.export_job(OPERATOR, storage.url, SERVICE, retry.RetryPolicy(max_attempts=3, base_delay_ms=50, max_delay_ms=100), sleep=lambda s: None)
        check(failed['outcome'] == 'failure' and failed['attempts'] == 3 and failed['error_class'] == 'UPSTREAM_5XX'
              and one('select status from private.export_jobs where id=%s', (backlog['job_id'],)) == 'PENDING', 'JOBS export worker failure retried, bounded, job left PENDING')
        fired = job_engine.process({'jobs': {'export': failed}})
        check({n['alert'] for n in fired} == {'JOB_FAILED', 'RETRY_REPEATED'}, 'OBS-06 job failure and repeated retries alert')
    finally:
        storage.close()
    succeeded = jobs.export_job(OPERATOR, URL, SERVICE)
    check(succeeded['outcome'] == 'success' and one('select status from private.export_jobs where id=%s', (backlog['job_id'],)) == 'READY',
          'JOBS export retry succeeds once Storage recovers')
    check({(n['alert'], n['status']) for n in job_engine.process({'jobs': {'export': succeeded}})} == {('JOB_FAILED', 'RESOLVED'), ('RETRY_REPEATED', 'RESOLVED')},
          'OBS-06 job recovery resolves the alerts')
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=1)).isoformat()
    retention = jobs.retention_job(OPERATOR, URL, SERVICE, t['org'], cutoff, 'OPS02-CI-RETENTION')
    check(retention['outcome'] == 'success', 'JOBS retention job runs through the offline operator role')
    journal_engine = engine('journal')
    with psycopg.connect(OPERATOR) as hold:
        hold.execute('set local role fichaje_retention_operator')
        hold_reason = 'Synthetic OPS-02 hold ' + secrets.token_hex(4)
        known.append(hold_reason)
        hold.execute('select private.record_legal_hold(%s,%s,%s,%s)', (t['org'], None, hold_reason, 'OPS02-HOLD'))
        blocked_journal = jobs.journal_check(OPERATOR, ARCHIVE, stale_minutes=0)
        check(blocked_journal['status'] == 'BLOCKED' and blocked_journal['in_progress'] >= 1, 'RES-04/H5 unresolved write-ahead journal entry detected')
        check([n['alert'] for n in journal_engine.process({'journal': blocked_journal})] == ['RECOVERY_JOURNAL_BLOCKED'], 'OBS-06 recovery journal blocked is CRITICAL')
        hold.rollback()
    reconciled = jobs.journal_reconcile(OPERATOR, ARCHIVE)
    ok_journal = jobs.journal_check(OPERATOR, ARCHIVE, stale_minutes=0)
    check(reconciled['outcome'] == 'success' and ok_journal['status'] == 'OK'
          and [(n['alert'], n['status']) for n in journal_engine.process({'journal': ok_journal})] == [('RECOVERY_JOURNAL_BLOCKED', 'RESOLVED')],
          'JOBS journal reconciliation (append-only) resolves the alert')

    # --- RES-02: release gate, real defect, alert, automatic rollback, back to green -------------
    release_engine = engine('release')
    gate_fn = lambda rid: release_gate.gate(rid, targets, can, app)  # noqa: E731
    promoted = release_gate.promote(deployer, 'ops02-r1', gate_fn, release_engine)
    check(promoted['state'] == 'PROMOTED' and deployer.state()['healthy'] == ['ops02-r1'], 'RES-02 healthy release passes health, synthetic tests, canary and gate')
    deployer.build('ops02-r2', commit)
    faults.break_release(deployer.path('ops02-r2'), 'gateway-record-broken')
    outcome = release_gate.promote(deployer, 'ops02-r2', gate_fn, release_engine)
    reports['release-r2'] = {k: v for k, v in outcome.items() if k != 'notifications'}
    degraded, restored = outcome['gates']
    check(outcome['state'] == 'ROLLED_BACK' and outcome['current'] == 'ops02-r1', 'RES-02 degraded candidate stopped and rolled back to the healthy release')
    check(degraded['status'] == 'FAIL' and degraded['health']['status'] == 'UP' and degraded['synthetic']['status'] == 'PASS'
          and degraded['canary']['channels']['kiosk']['status'] == 'FAIL' and degraded['canary']['channels']['web']['status'] == 'PASS',
          'RES-02 the real defect passes health checks and is caught by the kiosk canary')
    check(restored['status'] == 'PASS' and restored['synthetic']['checks']['artifact_identity'], 'RES-02 previous release restored: health and canary green again')
    check(len(sink.find('RELEASE_DEGRADED', 'FIRING')) == 1 and len(sink.find('RELEASE_DEGRADED', 'RESOLVED')) == 1
          and len(sink.find('CANARY_FAILED', 'FIRING', channel='kiosk')) == 1 and len(sink.find('CANARY_FAILED', 'RESOLVED', channel='kiosk')) == 1,
          'OBS-06 degraded release alerted and resolved after rollback')
    deployer.build('ops02-r3', commit)
    faults.break_release(deployer.path('ops02-r3'), 'app-missing-asset')
    outcome3 = release_gate.promote(deployer, 'ops02-r3', gate_fn, release_engine)
    check(outcome3['state'] == 'ROLLED_BACK' and outcome3['gates'][0]['health']['checks']['app']['status'] == 'DOWN'
          and len(sink.find('APP_DOWN', 'RESOLVED')) == 1, 'RES-02 broken application artifact detected by health, rolled back and resolved')
    r2_log = (deployer.workdir / 'logs' / 'ops02-r2-kiosk.log').read_text()
    check('"release":"ops02-r2"' in r2_log and '"operation":"clock.CLOCK_IN","outcome":"failure"' in r2_log,
          'OBS-01 gateway telemetry correlates the failure with the degraded release')

    # --- OBS-03/06: dependency failures through real fault injection --------------------------
    health_engine = engine('health')
    api_proxy = faults.HttpFaultProxy(URL)
    db_proxy = faults.TcpProxy('127.0.0.1', 54322)
    faulty = health.Targets(app_url=app, api_url=api_proxy.url, anon_key=ANON, db_dsn=monitor_dsn.replace(':54322/', f':{db_proxy.port}/'),
                            kiosk_url=targets.kiosk_url, export_link_url=targets.export_link_url)
    try:
        check(health_engine.process({'health': health.run(faulty)}) == [], 'OBS-03 proxied dependencies UP before injection')
        for label, (prefix, mode), check_name, alert, route in (
                ('API responds 5xx', ('/rest/', 'status:503'), 'api', 'API_DOWN', 'pager'),
                ('Auth unavailable', ('/auth/', 'refuse'), 'auth', 'AUTH_DOWN', 'pager'),
                ('artificial latency', ('/rest/', 'delay:1500'), 'api', 'LATENCY_HIGH', 'ticket')):
            api_proxy.set(prefix, mode)
            down = health.run(faulty, 3000)
            fired = health_engine.process({'health': down})
            expected_status = 'DEGRADED' if alert == 'LATENCY_HIGH' else 'DOWN'
            check(down['checks'][check_name]['status'] == expected_status and [(n['alert'], n['routes']) for n in fired] == [(alert, [route])],
                  f'OBS-03/06 {label}: {check_name} {expected_status} and {alert} routed to {route}')
            api_proxy.clear()
            up = health.run(faulty)
            check(up['status'] == 'UP' and [(n['alert'], n['status']) for n in health_engine.process({'health': up})] == [(alert, 'RESOLVED')],
                  f'OBS-03/06 {label} recovered and resolved')
        db_proxy.set('refuse')
        down = health.run(faulty, 3000)
        fired = health_engine.process({'health': down})
        check(down['checks']['postgres'] == {'status': 'DOWN', 'latency_ms': down['checks']['postgres']['latency_ms'], 'error_class': 'DB_UNAVAILABLE'}
              and [n['alert'] for n in fired] == ['POSTGRES_DOWN'], 'OBS-03/06 PostgreSQL unavailable: DOWN and POSTGRES_DOWN paged')
        db_proxy.set('pass')
        check([(n['alert'], n['status']) for n in health_engine.process({'health': health.run(faulty)})] == [('POSTGRES_DOWN', 'RESOLVED')],
              'OBS-03/06 PostgreSQL recovery resolves the alert')
    finally:
        api_proxy.close()
        db_proxy.close()
    real_engine = engine('real')
    faults.container('stop', 'supabase_auth_fichaje-h1')
    try:
        # Gateway readiness is cached (bounded load): detection within cache TTL + probe timeout.
        down = wait_report(targets, 3000, lambda r: r['checks']['auth']['status'] == 'DOWN' and r['checks']['kiosk_gateway']['status'] == 'DOWN')
        canary_down = can.run(('web',))
        fired = {n['alert'] for n in real_engine.process({'health': down, 'canary': canary_down})}
        check(down['checks']['auth']['status'] == 'DOWN' and down['checks']['kiosk_gateway']['status'] == 'DOWN' and canary_down['status'] == 'FAIL'
              and {'AUTH_DOWN', 'KIOSK_GATEWAY_DOWN', 'CANARY_FAILED'} <= fired, 'OBS-03/04/06 stopped Auth container detected by health, gateway readiness and canary')
    finally:
        faults.container('start', 'supabase_auth_fichaje-h1')
    wait_up(targets)
    recovered = {(n['alert'], n['status']) for n in real_engine.process({'health': health.run(targets), 'canary': can.run(('web',))})}
    check({('AUTH_DOWN', 'RESOLVED'), ('KIOSK_GATEWAY_DOWN', 'RESOLVED'), ('CANARY_FAILED', 'RESOLVED')} <= recovered,
          'OBS-06 Auth container recovery: canary green, alerts resolved')
    faults.container('pause', 'supabase_db_fichaje-h1')
    try:
        down = wait_report(targets, 2000, lambda r: r['checks']['postgres']['status'] == 'DOWN' and r['checks']['api']['status'] == 'DOWN')
        fired = {n['alert'] for n in real_engine.process({'health': down})}
        check(down['checks']['postgres']['status'] == 'DOWN' and {'POSTGRES_DOWN', 'API_DOWN'} <= fired, 'OBS-03/06 paused PostgreSQL container detected (DOWN) and paged')
    finally:
        faults.container('unpause', 'supabase_db_fichaje-h1')
    wait_up(targets)
    recovered = {(n['alert'], n['status']) for n in real_engine.process({'health': health.run(targets)})}
    check({('POSTGRES_DOWN', 'RESOLVED'), ('API_DOWN', 'RESOLVED')} <= recovered, 'OBS-06 PostgreSQL recovery resolves the alerts')

    # --- KIOSK metrics: authentication failures and rate limit ----------------------------------
    prov.gateway = gateway
    owner_token = api.token(state['tenant']['owner']['email'], state['tenant']['owner']['password'])
    limited, limited_code = prov.employee(state['tenant']['org'], owner_token, None, state['tenant']['policy'])
    limited_pin = prov.reset_pin(owner_token, state['tenant']['org'], limited, state['kiosk'])
    known.extend([limited, limited_code, limited_pin])
    device = api.token(state['kiosk']['device_email'], state['kiosk']['device_password'])
    wrong = '0' * 8 if limited_pin != '0' * 8 else '1' * 8
    statuses = []
    for _ in range(6):
        try:
            gateway.post('authenticate', device, {'organization_id': state['tenant']['org'], 'device_id': state['kiosk']['device_id'],
                         'code': limited_code, 'pin': wrong}, 'kiosk.authenticate', None, mutation=False)
        except retry.NotRetryable as error:
            statuses.append(error.error_class)
    check(statuses == ['AUTH_FAILED'] * 6, 'KIOSK wrong PINs and the active lock stay externally identical (AUTH_FAILED)')

    # --- RES-04: backups watched, DB never green -------------------------------------------------
    backup_checks(engine)

    # --- OBS-01/02: structure, correlation, metrics, client telemetry -----------------------------
    events = metrics.read_events([scratch / 'events.jsonl', *sorted((deployer.workdir / 'logs').glob('*.log'))])
    required = set(CONTRACT['required_event_fields'])
    check(len(events) > 200 and all(required <= set(e) and e['component'] in CONTRACT['components'] and e['operation'] in CONTRACT['operations']
                                    and e['outcome'] in CONTRACT['outcomes'] and e.get('error_class', 'NONE') in CONTRACT['error_classes']
                                    and set(e) <= set(CONTRACT['event_fields']) for e in events), 'OBS-01 every event from scripts and gateways follows the contract')
    gateway_events = [e for e in events if e['component'] == 'kiosk-gateway']
    check({e['release'] for e in gateway_events} >= {'ops02-r1', 'ops02-r2'} and all(re.match(r'^[0-9a-f]{40}$', e['commit']) for e in gateway_events),
          'OBS-01 gateway events carry release and commit')
    step_events = [e for e in events if e['component'] == 'canary' and e['operation'].startswith('clock.') and e['outcome'] == 'success' and 'request_id' in e]
    ids = sorted({e['request_id'] for e in step_events})
    check(len(ids) >= 16 and one('select count(distinct request_id) from public.audit_log where request_id = any(%s::uuid[])', (ids,)) == len(ids),
          'OBS-01 canary request_ids correlate one-to-one with audit evidence')
    kiosk_records = [e for e in gateway_events if e['operation'].startswith('clock.') and e['outcome'] == 'success']
    check(kiosk_records and one("select count(*) from public.audit_log where actor_kind='KIOSK' and request_id = any(%s::uuid[])",
                                (sorted({e['request_id'] for e in kiosk_records}),)) == len({e['request_id'] for e in kiosk_records}),
          'OBS-01 gateway request_ids correlate with KIOSK audit rows')
    registry = metrics.from_events(events)
    independent = sum(1 for e in events if e['component'] == 'canary' and e['operation'] == 'clock.CLOCK_IN' and e['outcome'] == 'success')
    check(registry.value('fichaje_ops_events_total', component='canary', operation='clock.CLOCK_IN', outcome='success', error_class='NONE') == independent > 0,
          'OBS-02 counters equal an independent count of the events')
    check(registry.value('fichaje_ops_events_total', component='kiosk-gateway', operation='kiosk.authenticate', outcome='rejected', error_class='RATE_LIMITED') >= 1
          and registry.value('fichaje_ops_events_total', component='kiosk-gateway', operation='kiosk.authenticate', outcome='rejected', error_class='AUTH_FAILED') >= 5,
          'OBS-02 kiosk authentication failures and rate-limit activations counted')
    check(registry.value('fichaje_ops_events_total', component='kiosk-gateway', operation='clock.CLOCK_IN', outcome='failure', error_class='INTERNAL') >= 1
          and registry.value('fichaje_ops_events_total', component='ops-suite', operation='clock.CLOCK_IN', outcome='unknown', error_class='UNKNOWN_OUTCOME') >= 1
          and registry.value('fichaje_ops_events_total', component='ops-suite', operation='clock.BREAK_START', outcome='rejected', error_class='VERSION_CONFLICT') >= 1
          and registry.value('fichaje_ops_events_total', component='ops-suite', operation='clock.BREAK_END', outcome='unknown', error_class='UNKNOWN_OUTCOME') >= 2
          and registry.value('fichaje_ops_events_total', component='canary', operation='clock.CLOCK_IN', outcome='rejected', error_class='POLICY_REQUIRED') >= 1
          and registry.value('fichaje_ops_events_total', component='canary', operation='clock.BREAK_START', outcome='rejected', error_class='CLOCK_REGRESSION') >= 1,
          'OBS-02 fichaje failures, timeouts/unknown outcomes, VERSION_CONFLICT, POLICY_REQUIRED and CLOCK_REGRESSION counted per action')
    histogram = registry.histogram('fichaje_ops_duration_ms', component='kiosk-gateway', operation='kiosk.authenticate')
    check(histogram and histogram['count'] == sum(1 for e in gateway_events if e['operation'] == 'kiosk.authenticate' and 'duration_ms' in e)
          and histogram['buckets'][0] == 0, 'OBS-02 latency histogram aggregates correctly (uniform 300 ms floor visible)')
    for name in ('health-up',):
        metrics.from_reports({'health': reports[name]}, registry)
    worker_token = api.token(state['tenant']['worker']['email'], state['tenant']['worker']['password'])
    batch = [{'operation': 'clock.CLOCK_IN', 'outcome': 'success', 'error_class': 'NONE', 'count': 2, 'sum_ms': 180.5, 'buckets': [0, 1, 1, 0, 0, 0, 0, 0, 0, 0]},
             {'operation': 'clock.BREAK_END', 'outcome': 'unknown', 'error_class': 'TIMEOUT', 'count': 1, 'sum_ms': 15000, 'buckets': [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]}]
    for _ in range(2):
        check(api.rpc('ops_ingest_client_metrics', worker_token, {'p_batch': batch}, 'rpc.other', True) == {'accepted': 2},
              'OBS-02 browser telemetry accepted through the write-only RPC')
    try:
        api.rpc('ops_ingest_client_metrics', worker_token, {'p_batch': [dict(batch[0], employee_id=state['tenant']['employee'])]}, 'rpc.other', True)
        raise AssertionError('identifier accepted')
    except retry.NotRetryable as error:
        check(error.error_class == 'INVALID_INPUT', 'OBS-02 telemetry carrying an identifier is rejected')
    with psycopg.connect(monitor_dsn) as connection:
        client_rows = [dict(zip(('bucket_start', 'operation', 'outcome', 'error_class', 'requests', 'duration_sum_ms', 'duration_buckets'), row))
                       for row in connection.execute('select * from private.ops_client_metrics_snapshot(null)').fetchall()]
    metrics.from_client_rows(client_rows, registry)
    check(registry.value('fichaje_frontend_requests_total', operation='clock.CLOCK_IN', outcome='success', error_class='NONE') == 4
          and registry.value('fichaje_frontend_requests_total', operation='clock.BREAK_END', outcome='unknown', error_class='TIMEOUT') == 2,
          'OBS-02 client counters aggregate without identities')
    vocabulary = rows('select kind,value from private.ops_telemetry_vocabulary order by 1,2')
    expected_vocab = sorted([('error_class', v) for v in CONTRACT['client_vocabulary']['error_classes']] + [('operation', v) for v in CONTRACT['client_vocabulary']['operations']]
                            + [('outcome', v) for v in CONTRACT['client_vocabulary']['outcomes']])
    check(sorted(vocabulary) == expected_vocab, 'OBS-02 database ingestion vocabulary equals the contract')
    prom = registry.render()
    reports['metrics'] = prom
    labels = re.findall(r'(\w+)="([^"]*)"', prom)
    allowed = {k: set(opslib.enum(v)) for spec in CONTRACT['metrics'].values() for k, v in spec['labels'].items()}
    check(labels and all(k == 'le' or v in allowed.get(k, ()) for k, v in labels)
          and not re.search(r'[0-9a-f]{8}-[0-9a-f]{4}-|@', prom), 'OBS-02/07 metric labels only from bounded enumerations: no identifiers, emails or tenants')

    # --- OBS-07: human roles never reach technical telemetry --------------------------------------
    humans = [('OWNER', owner_token), ('EMPLOYEE', worker_token), ('ADMIN', r['admin']['token']), ('anon', None)]
    functions = ['ops_invariant_summary', 'ops_record_invariant_run', 'ops_invariant_findings', 'ops_affected_tenants', 'ops_rebuild_projection',
                 'ops_projection_candidates', 'ops_client_metrics_snapshot', 'ops_db_health']
    denied = []
    for role, token in humans:
        for fn in functions:
            try:
                opslib.http_json('POST', f'{URL}/rest/v1/rpc/{fn}', api.headers(token), json.dumps({'p_org': d5['org']}).encode(), 10)
                denied.append(False)
            except opslib.HttpError as error:
                denied.append(error.status in (401, 403, 404))
        for table in ('ops_client_metrics', 'ops_invariant_findings', 'ops_projection_repairs'):
            try:
                opslib.http_json('GET', f'{URL}/rest/v1/{table}?select=*', api.headers(token), None, 10)
                denied.append(False)
            except opslib.HttpError as error:
                denied.append(error.status in (401, 403, 404))
    check(all(denied), 'OBS-07 no OWNER/ADMIN/EMPLOYEE/anon identity reaches technical OPS functions or tables')
    try:
        api.rpc('ops_ingest_client_metrics', None, {'p_batch': batch}, 'rpc.other', True)
        raise AssertionError('anonymous ingestion')
    except retry.NotRetryable as error:
        check(error.error_class in ('UNAUTHENTICATED', 'FORBIDDEN'), 'OBS-07 anonymous callers cannot add telemetry')
    scoped = invariants.findings(reviewer_dsn, d4['org'])
    check(scoped and one('select count(*) from private.ops_invariant_findings(%s) where organization_id<>%s', (d4['org'], d4['org'])) == 0,
          'OBS-07 human review is tenant-scoped: tenant A detail never includes tenant B')
    check(one("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'ops\\_%%'") == 1,
          'OBS-07 the only OPS entry point in the API schema is the write-only ingestion RPC')

    # --- SEC-OPS-01: direct abuse of the ingestion RPC (PostgREST over HTTP, no browser limits) ----
    sec_ops_01(deployer, sink, monitor_dsn, state)

    # --- Absolute rule: no automated path rewrote labour history -----------------------------------
    check(one("select count(*) from public.audit_log where actor_kind='SYSTEM' and action not in ('bootstrap','rebuild_projection','legal_hold','release_hold','purge_labour','recovery_replay')") == 0,
          'RULE no automation wrote labour evidence (only authorized projection rebuilds are SYSTEM actions)')
    check(one("""select count(*) from public.time_events e where (select count(*) from public.audit_log a where a.organization_id=e.organization_id
        and a.entity_id=e.id and a.action in ('record_time_event','kiosk_record_event')) <> 1""") == 0,
          'RULE every original still present has exactly one audit row: no fichaje was invented, closed or rewritten by automation')

    # --- Final leak gate over every OPS output ----------------------------------------------------
    blobs = {str(p): p.read_bytes() for p in [scratch / 'events.jsonl', *(deployer.workdir / 'logs').glob('*.log'), *scratch.glob('alerts-*.json')]}
    blobs['sink'] = json.dumps(sink.received).encode()
    blobs['reports'] = json.dumps(reports, default=str).encode()
    found = leakscan.scan(blobs, known)
    check(found == [], f'OBS-01/07 no secret, credential, PIN, email, name, code, reason or record identifier in logs, metrics, alerts or reports ({len(blobs)} outputs)')
    print(f'PASS OPS-02: {checks} real checks; synthetic data only; no artefact uploaded.', flush=True)


def sec_ops_01(deployer, sink, monitor_dsn, state):
    """Every call goes straight to the RPC with raw HTTP: no retries, no OBS-01 event, no frontend."""
    limited = (200, {'accepted': 0, 'limited': True})
    abusers: list[dict] = []

    def ingest(token, body):
        try:
            return opslib.http_json('POST', f'{URL}/rest/v1/rpc/ops_ingest_client_metrics', api.headers(token), json.dumps(body).encode(), 15)
        except opslib.HttpError as error:
            return error.status, error.error_class

    def item(operation, outcome='failure', error_class='UPSTREAM_5XX'):
        return {'operation': operation, 'outcome': outcome, 'error_class': error_class, 'count': 1, 'sum_ms': 60, 'buckets': [0, 1] + [0] * 8}

    def identity(label):
        person = prov.account(label)
        person['token'] = api.token(person['email'], person['password'])
        known.extend([person['email'], person['password'], person['id']])
        abusers.append(person)
        return person

    def fresh_window(margin=100):
        """Each block runs inside one 5-minute quota window (the metric bucket)."""
        remaining = 300 - float(one('select extract(epoch from clock_timestamp())')) % 300
        if remaining < margin:
            time.sleep(remaining + 1)
        return one("select date_bin('5 minutes',clock_timestamp(),timestamptz '2000-01-01 00:00:00+00')")

    def total(operation, outcome='failure', error_class='UPSTREAM_5XX'):
        return int(one('select coalesce(sum(requests),0) from private.ops_client_metrics where operation=%s and outcome=%s and error_class=%s',
                       (operation, outcome, error_class)))

    def bucket_rows(at):
        return one('select count(*) from private.ops_client_metrics where bucket_start=%s', (at,))

    def quota(person, at):
        """Test-only recomputation of the pseudonym (needs the window's private salt)."""
        return rows("""select s.attempts,s.events,s.series from private.ops_ingest_subjects s join private.ops_ingest_windows w using(window_start)
                       where s.window_start=%s and s.subject=encode(sha256(w.salt||convert_to(%s,'UTF8')),'hex')""", (at, person['id']))

    def operator(statement, params=()):
        with psycopg.connect(OPERATOR, autocommit=True) as connection:
            connection.execute(statement, params)

    def trusted_state():
        server = metrics.read_events([scratch / 'events.jsonl', *sorted((deployer.workdir / 'logs').glob('*.log'))])
        rates = metrics.rates(server)
        return {'history': history(), 'repairs': one('select count(*) from private.ops_projection_repairs'),
                'projection': one("select md5(coalesce(string_agg(row_to_json(s)::text,'' order by s.organization_id,s.employee_id),'')) from private.employee_state s"),
                'system': one("select count(*) from public.audit_log where actor_kind='SYSTEM'"), 'release': deployer.state(),
                'notifications': len(sink.received), 'rates': rates, 'decisions': alerts.evaluate({'metrics': rates})}

    limits = dict(zip(('calls', 'events', 'series', 'subjects', 'global_events', 'bucket_series', 'retention'), rows(
        'select subject_calls,subject_events,subject_series,global_subjects,global_events,bucket_series,retention_days from private.ops_ingest_limits')[0]))
    check(limits == {'calls': 30, 'events': 2000, 'series': 200, 'subjects': 5000, 'global_events': 200000, 'bucket_series': 1000, 'retention': 7},
          'SEC-OPS-01 server-side limits in force per identity, per window and per bucket, with retention')
    trusted = trusted_state()

    # Many consecutive calls from one identity; a second identity keeps its own quota.
    at = fresh_window()
    attacker, bystander = identity('abuse-a'), identity('abuse-b')
    before = total('rpc.classify_hours')
    sequence = [ingest(attacker['token'], {'p_batch': [item('rpc.classify_hours')]}) for _ in range(limits['calls'] + 10)]
    check(sequence == [(200, {'accepted': 1})] * limits['calls'] + [limited] * 10 and total('rpc.classify_hours') == before + limits['calls'],
          f'SEC-OPS-01 {limits["calls"] + 10} consecutive calls from one identity: exactly {limits["calls"]} reach the aggregates')
    check(quota(attacker, at) == [(limits['calls'] + 10, limits['calls'], limits['calls'])],
          'SEC-OPS-01 the quota is persistent: limited attempts are committed too')
    check(ingest(bystander['token'], {'p_batch': [item('rpc.classify_hours')]}) == (200, {'accepted': 1})
          and total('rpc.classify_hours') == before + limits['calls'] + 1, 'SEC-OPS-01 a second identity does not inherit the first one\'s block')

    # Inflated, oversized, out-of-vocabulary or identifying payloads: rejected before any write.
    vocab = CONTRACT['client_vocabulary']
    combos = [{'operation': o, 'outcome': r, 'error_class': e, 'count': 1, 'sum_ms': 10, 'buckets': [1] + [0] * 9}
              for o in vocab['operations'] if o.startswith('kiosk.') for r in vocab['outcomes'] for e in vocab['error_classes']]
    malformed = {
        'count=9999': [dict(item('select', 'success', 'NONE'), count=9999, sum_ms=100, buckets=[9999] + [0] * 9)],
        'count=1001': [dict(item('select', 'success', 'NONE'), count=1001, sum_ms=100, buckets=[1001] + [0] * 9)],
        'duration outside its bucket': [dict(item('select', 'success', 'NONE'), sum_ms=999999999)],
        'open bucket over 120 s': [dict(item('select', 'success', 'NONE'), sum_ms=120001, buckets=[0] * 9 + [1])],
        '101 series': combos[:101],
        'duplicated series': [item('select'), item('select')],
        'operation out of vocabulary': [item('clock.FORGED')],
        'outcome out of vocabulary': [item('select', outcome='maybe')],
        'error class out of vocabulary': [item('select', error_class='SQLSTATE_23505')],
        'tenant as operation': [item(state['tenant']['org'])],
        'employee attached': [dict(item('select'), employee_id=state['tenant']['employee'])],
        'email attached': [dict(item('select'), email=bystander['email'])],
        'request attached': [dict(item('select'), request_id=uid())],
    }
    rows_before = one('select count(*) from private.ops_client_metrics')
    rejected = {name: ingest(bystander['token'], {'p_batch': payload}) for name, payload in malformed.items()}
    check(all(result == (400, 'INVALID_INPUT') for result in rejected.values()) and one('select count(*) from private.ops_client_metrics') == rows_before
          and quota(bystander, at) == [(1, 1, 1)],
          f'SEC-OPS-01 {len(rejected)} inflated/oversized/out-of-vocabulary/identifying payloads (count=9999 included) rejected with no write')
    anonymous = ingest(None, {'p_batch': [item('select')]})
    check(anonymous[0] in (401, 403) and one('select count(*) from private.ops_client_metrics') == rows_before, 'SEC-OPS-01 anonymous calls refused, nothing written')

    # Random releases: no parameter, key, column or label can carry them.
    releases = [f'{secrets.token_hex(4)}.{n}' for n in range(20)]
    forged_release = [ingest(bystander['token'], {'p_release': release, 'p_batch': [item('select')]}) for release in releases]
    smuggled = [ingest(bystander['token'], {'p_batch': [dict(item('select'), release=release)]}) for release in releases[:5]]
    check(all(status in (400, 404) for status, _ in forged_release) and all(result == (400, 'INVALID_INPUT') for result in smuggled)
          and one('select count(*) from private.ops_client_metrics') == rows_before
          and one("select count(*) from information_schema.columns where table_schema='private' and table_name like 'ops%%' and column_name='release'") == 0
          and rows("select p.proargnames from pg_proc p where p.pronamespace='public'::regnamespace and p.proname='ops_ingest_client_metrics'") == [(['p_batch'],)],
          'SEC-OPS-01 20 random releases refused: the RPC takes no release, no store has a release column, no row added')

    # 100 series per call: repeated series add no rows; the per-identity series quota stops the third call.
    at = fresh_window()
    heavy = identity('abuse-c')
    rows_before = bucket_rows(at)
    hundred = [ingest(heavy['token'], {'p_batch': combos[:100]}) for _ in range(3)]
    check(hundred == [(200, {'accepted': 100}), (200, {'accepted': 100}), limited] and bucket_rows(at) == rows_before + 100
          and quota(heavy, at) == [(3, 200, 200)], 'SEC-OPS-01 100 series per call bounded: rows grow only by distinct accepted series')

    # Concurrency: two identities fire 40 simultaneous calls each.
    at = fresh_window()
    racers = [identity('race-a'), identity('race-b')]
    before = total('rpc.create_invitation')
    barrier = threading.Barrier(80)
    raced: dict[str, list] = {person['id']: [] for person in racers}

    def race(person):
        barrier.wait()
        raced[person['id']].append(ingest(person['token'], {'p_batch': [item('rpc.create_invitation')]}))

    threads = [threading.Thread(target=race, args=(person,)) for _ in range(40) for person in racers]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    check(all(len(results) == 40 and results.count((200, {'accepted': 1})) == limits['calls'] and results.count(limited) == 40 - limits['calls']
              for results in raced.values())
          and total('rpc.create_invitation') == before + 2 * limits['calls']
          and all(quota(person, at) == [(40, limits['calls'], limits['calls'])] for person in racers),
          f'SEC-OPS-01 concurrency cannot bypass the quota: 2 identities x 40 simultaneous calls, exactly {limits["calls"]} accepted each, no error')

    # Window expiry: the next window resets the quota and purges stale pseudonymous state.
    at = fresh_window()
    spent = [ingest(attacker['token'], {'p_batch': [item('rpc.classify_hours')]}) for _ in range(limits['calls'] + 1)]
    operator("update private.ops_ingest_subjects set window_start=window_start-interval '1 hour'")
    operator("update private.ops_ingest_windows set window_start=window_start-interval '1 hour'")
    reset = ingest(attacker['token'], {'p_batch': [item('rpc.classify_hours')]})
    check(spent[-1] == limited and reset == (200, {'accepted': 1}) and quota(attacker, at) == [(1, 1, 1)]
          and one('select count(*) from private.ops_ingest_windows where window_start<%s', (at,)) == 0
          and one('select count(*) from private.ops_ingest_subjects where window_start<%s', (at,)) == 0,
          'SEC-OPS-01 an expired window resets the identity\'s quota; stale quota rows and salts are purged')

    # Intentional global limits (operator-tuned): volume, identities and rows per window. The caps are
    # set from the live window counters, so the next call of any identity crosses them.
    at = fresh_window()
    g1, g2, g3 = identity('global-a'), identity('global-b'), identity('global-c')
    seen = item('export.link', 'timeout', 'TIMEOUT')
    first = ingest(g1['token'], {'p_batch': [seen]})
    try:
        operator('update private.ops_ingest_limits set global_events=(select events from private.ops_ingest_windows where window_start=%s)', (at,))
        volume = [ingest(g1['token'], {'p_batch': [seen]}), ingest(g2['token'], {'p_batch': [seen]})]
        operator('update private.ops_ingest_limits set global_events=%s,global_subjects=(select subjects from private.ops_ingest_windows where window_start=%s)',
                 (limits['global_events'], at))
        crowd = ingest(g3['token'], {'p_batch': [seen]})
        crowd_row = quota(g3, at)
        operator('update private.ops_ingest_limits set global_subjects=%s,bucket_series=(select series from private.ops_ingest_windows where window_start=%s)',
                 (limits['subjects'], at))
        full = [ingest(g3['token'], {'p_batch': [item('auth.sign_in', 'rejected', 'AUTH_FAILED')]}), ingest(g3['token'], {'p_batch': [seen]})]
    finally:
        operator('update private.ops_ingest_limits set global_events=%s,global_subjects=%s,bucket_series=%s',
                 (limits['global_events'], limits['subjects'], limits['bucket_series']))
    relaxed = ingest(g3['token'], {'p_batch': [item('auth.sign_in', 'rejected', 'AUTH_FAILED')]})
    check(first == (200, {'accepted': 1}) and volume == [limited, limited] and crowd == limited and crowd_row == []
          and full == [limited, (200, {'accepted': 1})] and relaxed == (200, {'accepted': 1})
          and rows('select subject_calls,subject_events,subject_series,global_subjects,global_events,bucket_series,retention_days from private.ops_ingest_limits')
          == [tuple(limits.values())],
          'SEC-OPS-01 intentional global limits (volume, identities, bucket rows) apply to every identity and lift when relaxed')

    # Forged failures: visible on dashboards only; never an alert, rollback, repair or labour change.
    fresh_window()
    forger = identity('forger')
    forged = ingest(forger['token'], {'p_batch': [{'operation': 'clock.CLOCK_IN', 'outcome': 'rejected', 'error_class': 'CLOCK_REGRESSION',
                                                   'count': 1000, 'sum_ms': 120000000, 'buckets': [0] * 9 + [1000]}]})
    with psycopg.connect(monitor_dsn) as connection:
        client_rows = [dict(zip(('bucket_start', 'operation', 'outcome', 'error_class', 'requests', 'duration_sum_ms', 'duration_buckets'), row))
                       for row in connection.execute('select * from private.ops_client_metrics_snapshot(null)').fetchall()]
    dashboard = metrics.from_client_rows(client_rows)
    after = trusted_state()
    decisions = alerts.evaluate({'metrics': after['rates'], 'client': client_rows, 'frontend': dashboard})
    check(forged == (200, {'accepted': 1})
          and dashboard.value('fichaje_frontend_requests_total', operation='clock.CLOCK_IN', outcome='rejected', error_class='CLOCK_REGRESSION') >= 1000,
          'SEC-OPS-01 forged client failures are stored only as untrusted dashboard aggregates')
    check(alerts.evaluate({'client': client_rows, 'frontend': dashboard}) == (set(), []),
          'SEC-OPS-01 browser telemetry alone (1000 forged CLOCK_REGRESSION) is no alert source and raises no condition')
    changed = sorted(key for key in trusted if after[key] != trusted[key])   # key names only, never values
    check(not changed and decisions == trusted['decisions'],
          'SEC-OPS-01 abuse left trusted metrics, alert decisions, notifications, release state (no rollback), repairs, projection and labour history unchanged'
          + (f' (changed: {",".join(changed)})' if changed else ''))

    # No identity anywhere; bounded growth.
    subjects = [r[0] for r in rows('select subject from private.ops_ingest_subjects')]
    known.extend(subjects)
    prom = dashboard.render()
    reports['metrics-after-abuse'] = prom
    columns = [r[0] for r in rows("select column_name from information_schema.columns where table_schema='private' and table_name='ops_ingest_subjects' order by ordinal_position")]
    check(columns == ['window_start', 'subject', 'attempts', 'events', 'series'] and subjects
          and not any(p['id'] in s or s in (hashlib.sha256(p['id'].encode()).hexdigest(), hashlib.sha256(p['email'].encode()).hexdigest()) for p in abusers for s in subjects)
          and not any(v in prom for p in abusers for v in (p['id'], p['email'])) and not any(s in prom for s in subjects),
          'SEC-OPS-01 quota state holds per-window keyed pseudonyms only; no uid, email or pseudonym reaches metrics')
    check(one('select max(n) from (select count(*) as n from private.ops_client_metrics group by bucket_start) b') <= limits['bucket_series']
          and one('select count(*) from private.ops_ingest_windows') <= 2 and one('select count(*) from private.ops_ingest_subjects') <= 2 * limits['subjects'],
          'SEC-OPS-01 bounded growth: rows per bucket under the cap; quota state only for the current and previous window')


def wait_report(targets, timeout_ms, predicate, timeout_s=45):
    deadline = time.monotonic() + timeout_s
    while True:
        report = health.run(targets, timeout_ms)
        if predicate(report):
            return report
        if time.monotonic() > deadline:
            raise AssertionError('fault not detected in time')
        time.sleep(1)


def wait_up(targets, timeout_s=90):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        report = health.run(targets, 3000)
        if report['status'] == 'UP':
            return report
        time.sleep(2)
    raise AssertionError('stack did not recover')


def backup_checks(engine):
    repo = scratch / 'backup-repo'
    repo.mkdir()
    git = lambda *a: subprocess.run(['git', '-C', str(repo), *a], check=True, capture_output=True)  # noqa: E731
    git('init', '-b', 'main')
    git('config', 'user.name', 'Synthetic')
    git('config', 'user.email', 'synthetic@example.invalid')
    (repo / 'README.md').write_text('synthetic\n')
    git('add', '.')
    git('commit', '-m', 'synthetic')
    out = scratch / 'backup-out'
    subprocess.run(['bash', str(ROOT / 'scripts' / 'backup_repo.sh'), str(out)], cwd=repo, check=True, capture_output=True,
                   env={**os.environ, 'BACKUP_UPLOAD_DRIVE': '0'})

    def artifact(corrupt=None) -> bytes:
        buffer = __import__('io').BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for path in out.rglob('*'):
                if path.is_file():
                    data = path.read_bytes()
                    if corrupt == 'bundle' and path.name == 'repository.bundle':
                        data = data[:-64] + b'0' * 64
                    if corrupt == 'sums' and path.name == 'SHA256SUMS':
                        continue
                    archive.writestr(str(path.relative_to(out)), data)
        return buffer.getvalue()

    now = datetime.now(timezone.utc)
    scenarios = {
        'ok': ([('success', 1)], True, None), 'near': ([('success', 25)], True, None), 'stale': ([('success', 30)], True, None),
        'failed': ([('failure', 1), ('success', 5)], True, None), 'none': ([], True, None), 'no-artifact': ([('success', 1)], False, None),
        'unverified': ([('success', 1)], True, 'bundle'), 'no-sums': ([('success', 1)], True, 'sums'),
    }
    current = {'name': 'ok'}

    class FakeGitHub(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            runs, has_artifact, corrupt = scenarios[current['name']]
            if self.headers.get('Authorization') != 'Bearer synthetic-token':
                self.send_response(401)
                self.end_headers()
                return
            if self.path.startswith('/repos/synthetic/repo/actions/workflows/backup.yml/runs'):
                body = {'workflow_runs': [{'id': 100 + i, 'status': 'completed', 'conclusion': c,
                                           'updated_at': (now - timedelta(hours=h)).isoformat().replace('+00:00', 'Z')} for i, (c, h) in enumerate(runs)]}
            elif self.path.startswith('/repos/synthetic/repo/actions/runs/'):
                body = {'artifacts': [{'id': 7, 'name': 'repository-100-1', 'size_in_bytes': 1024, 'expired': False, 'digest': 'sha256:' + '0' * 64}] if has_artifact else []}
            elif self.path == '/repos/synthetic/repo/actions/artifacts/7/zip':
                data = artifact(corrupt)
                self.send_response(200)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            else:
                self.send_response(404)
                self.end_headers()
                return
            data = json.dumps(body).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    server = ThreadingHTTPServer(('127.0.0.1', 0), FakeGitHub)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    backup_engine = engine('backup')
    github = backup_monitor.GitHub(f'http://127.0.0.1:{server.server_port}', 'synthetic/repo', 'synthetic-token')
    try:
        expected = {'ok': 'OK', 'near': 'OK', 'stale': 'STALE', 'failed': 'FAILED', 'none': 'MISSING', 'no-artifact': 'MISSING',
                    'unverified': 'UNVERIFIED', 'no-sums': 'UNVERIFIED'}
        alert_for = {'STALE': 'BACKUP_STALE', 'FAILED': 'BACKUP_FAILED', 'MISSING': 'BACKUP_MISSING', 'UNVERIFIED': 'BACKUP_UNVERIFIED'}
        for name in ('ok', 'stale', 'ok', 'failed', 'ok', 'none', 'ok', 'no-artifact', 'ok', 'unverified', 'ok', 'no-sums', 'ok', 'near'):
            current['name'] = name
            report = backup_monitor.monitor(github, now=now)
            reports[f'backup-{name}'] = report
            notes = backup_engine.process({'backup': report})
            repo_status = report['repo']['status']
            if name == 'ok':
                check(repo_status == 'OK' and report['repo']['verified'] and report['repo']['restore_tested'],
                      'RES-04 recent successful backup: checksums, bundle and restore rehearsal verified')
            elif name == 'near':
                check(repo_status == 'OK' and [n['alert'] for n in notes] == ['BACKUP_NEAR_STALE'], 'RES-04 backup approaching the freshness threshold warns')
            else:
                check(repo_status == expected[name] and [n['alert'] for n in notes if n['status'] == 'FIRING'] == [alert_for[expected[name]]]
                      and all(n['routes'] == ['pager'] for n in notes), f'RES-04 {name} backup detected and paged as {alert_for[expected[name]]}')
            check(report['database']['status'] == 'NOT_CONFIGURED', f'RES-04 DB backup explicitly NOT_CONFIGURED ({name})')
        check(len(backup_engine.firing()) == 2 and {a['alert'] for a in backup_engine.firing()} == {'DB_BACKUP_NOT_CONFIGURED', 'BACKUP_NEAR_STALE'},
              'RES-04 DB backup never turns green: its warning stays firing')
        check(backup_monitor.database_backup_blocked(), 'RES-04 backup_database.sh still refuses to run (hard gate until H7)')
        check(backup_monitor.evaluate_db_manifest({'result': 'success', 'completed_at': now.isoformat(), 'encrypted': True, 'ciphertext_sha256': 'x'}, now)['status'] == 'UNVERIFIED',
              'RES-04 future DB contract: upload without restore test is not green')
        registry = metrics.from_reports({'backup': reports['backup-ok']})
        check(registry.value('fichaje_backup_ok', kind='repo') == 1 and registry.value('fichaje_backup_ok', kind='database') == 0,
              'OBS-02 backup gauges: repo OK, database 0 while NOT_CONFIGURED')
        current['name'] = 'ok'
        unauthorised = backup_monitor.monitor(backup_monitor.GitHub(github.api, 'synthetic/repo', None), now=now)
        check(unauthorised['repo']['status'] != 'OK', 'RES-04 without API access the monitor never reports OK')
    finally:
        server.shutdown()
        server.server_close()


def report_failure(error: BaseException) -> None:
    """Safe failure report (as H4): the static check label, the exception type or stable class,
    code locations and failing operational events by enumerated fields only. Never values, SQL,
    HTTP bodies or synthetic secrets (CI logs may be public)."""
    import traceback
    detail = str(error) if isinstance(error, AssertionError) else getattr(error, 'error_class', '')
    print(f'FAIL OPS-02 after {checks} checks: {type(error).__name__} {detail}'.rstrip(), flush=True)
    for frame in traceback.extract_tb(error.__traceback__):
        print(f'  {frame.filename}:{frame.lineno} in {frame.name}', flush=True)
    paths = [scratch / 'events.jsonl', *sorted((scratch / 'deploy' / 'logs').glob('*.log'))]
    failures = [e for e in metrics.read_events([p for p in paths if p.exists()]) if e['outcome'] in ('failure', 'unknown', 'timeout')]
    for event in failures[-20:]:
        print('  event', *(event.get(k, '-') for k in ('component', 'operation', 'outcome', 'error_class', 'stage')), flush=True)


if __name__ == '__main__':
    try:
        main()
    except BaseException as failure:  # noqa: BLE001 -- reported safely, then re-raised as exit 1
        report_failure(failure)
        raise SystemExit(1)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

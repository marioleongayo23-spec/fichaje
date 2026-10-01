"""H7 incident response drill (synthetic, local staging shape) with real timestamps.

Scenario IR-01: the credential of a kiosk device is stolen and used to guess PINs
through the edge; the edge ingress secret is treated as possibly exposed. The drill
walks every phase with the real system: detection (alert), containment and
revocation, evidence preservation (hashes, no PII), affected-scope assessment,
recovery, credential rotation without downtime, notification decision, authorized
reopening and the data for the postmortem. No real person, company or data.
"""
import base64
import hashlib
import hmac
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from h7_support import (OPERATOR, KioskAdmin, Processes, Suite, build_dist, canary_mod, drop_logins, functions_env, http,  # noqa: E402
                        http_json, kiosk_employee, leak_scan, login, make_tenant, one, reset_opslog, secret_b64, stack, start_edge,
                        start_functions, wait_http)
import alerts  # noqa: E402
import invariants  # noqa: E402
import metrics  # noqa: E402

suite = Suite('h7-incident')
check = suite.check
S = stack()
suite.remember(S['service'])
api = canary_mod.Api(S['url'], S['anon'])
reset_opslog(suite.scratch / 'ops-events.jsonl')
processes = Processes(suite.scratch / 'logs')
KIOSK_PORT, EXPORT_PORT, EDGE_PORT = 8770, 8006, 8793
T: dict[str, float] = {}


def mark(name: str) -> None:
    T[name] = time.time()


def gateway_events(since: float) -> list[dict]:
    events = []
    for log in (suite.scratch / 'logs').glob('*kiosk*.log'):
        for line in log.read_text().splitlines():
            if line.startswith('{'):
                event = json.loads(line)
                if datetime.fromisoformat(event['ts'].replace('Z', '+00:00')).timestamp() >= since:
                    events.append(event)
    return events


def labour_digest(org: str) -> str:
    """Labour history only (fichajes, sessions, corrections); receipts of admin actions may grow."""
    tables = ('public.time_events', 'public.work_sessions', 'public.event_adjustments', 'public.correction_decisions', 'public.correction_requests')
    parts = ",".join(f"(select coalesce(string_agg(row_to_json(t)::text,'' order by t.id),'') from {table} t where t.organization_id=%(o)s)"
                     for table in tables)
    return one(f'select md5(concat_ws(chr(1),{parts}))', {'o': org})


def authenticate(edge: str, token: str, org: str, device: str, code: str, pin: str):
    return http_json('POST', edge + '/gateway/kiosk/authenticate', {'Authorization': 'Bearer ' + token},
                     {'organization_id': org, 'device_id': device, 'code': code, 'pin': pin})


def sign(secret: str, ts: int, method: str, component: str, route: str, body: bytes) -> str:
    canonical = f'fichaje-edge-v1\n{ts}\n{method}\n{component}\n{route}\n{hashlib.sha256(body).hexdigest()}'.encode()
    return f'v1.{ts}.' + hmac.new(base64.b64decode(secret), canonical, hashlib.sha256).hexdigest()


def main() -> None:
    gateway_dsn = login(suite, 'kiosk_h7_ir', 'fichaje_gateway')
    monitor_dsn = login(suite, 'ops_monitor_ir', 'fichaje_ops_monitor')
    pepper, network, s1, s2 = secret_b64(), secret_b64(), secret_b64(), secret_b64()
    suite.remember(pepper, network, s1, s2)
    dist = build_dist(suite.scratch / 'dist', S['url'], S['publishable'], 'h7-ir')
    fenv = lambda **extra: {**functions_env(S, gateway_dsn, pepper, network, None, 'h7-ir'), **extra}  # noqa: E731
    upstreams = {'FICHAJE_KIOSK_UPSTREAM': f'http://127.0.0.1:{KIOSK_PORT}', 'FICHAJE_EXPORT_LINK_UPSTREAM': f'http://127.0.0.1:{EXPORT_PORT}'}
    start_functions(processes, fenv(FICHAJE_INGRESS_SECRET=s1), KIOSK_PORT, EXPORT_PORT, tag='fn-1')
    edge = start_edge(processes, suite.scratch, dist, EDGE_PORT, {**upstreams, 'FICHAJE_INGRESS_SECRET': s1}, tag='edge-1')
    sink = alerts.TestSink()
    sink.__enter__()
    engine = alerts.AlertEngine(suite.scratch / 'alerts.json', {'pager': [alerts.Notifier(sink.url + '/pager')],
                                                                'ticket': [alerts.Notifier(sink.url + '/ticket')]}, 'ci')
    report: dict = {}
    try:
        prov = canary_mod.Provisioner(api, S['service'], OPERATOR, None)
        admin = KioskAdmin(edge + '/gateway/kiosk')
        tenant = make_tenant(suite, api, prov, workers=1, admins=1)
        people = [kiosk_employee(suite, prov, admin, tenant) for _ in range(3)]
        stolen, legit = admin.provision(api, tenant['owner']['token'], tenant['org']), admin.provision(api, tenant['owner']['token'], tenant['org'])
        suite.remember(stolen['password'], legit['password'])
        offer = authenticate(edge, legit['token'], tenant['org'], legit['id'], people[0]['code'], people[0]['pin'])[2]
        check(offer['actions'] == ['CLOCK_IN'], 'IR setup: synthetic tenant, two kiosks and three people without email operating normally')
        baseline = labour_digest(tenant['org'])
        audit_before = one('select count(*) from public.audit_log where organization_id=%s', (tenant['org'],))

        # --- Attack and detection --------------------------------------------------------------------------
        mark('t0_attack')
        attacker = api.token(stolen['email'], stolen['password'])
        statuses = [authenticate(edge, attacker, tenant['org'], stolen['id'], f'guess-{i}', f'{i:08d}')[0] for i in range(35)]
        check(set(statuses) == {403}, 'IR attack: 35 PIN guesses with the stolen device credential all refused generically')
        signals = {'metrics': metrics.rates(gateway_events(T['t0_attack']), 'kiosk-gateway')}
        fired = engine.process(signals)
        mark('t1_detected')
        check([n['alert'] for n in fired] == ['KIOSK_AUTH_ABUSE'] and sink.find('KIOSK_AUTH_ABUSE', 'FIRING'),
              'IR detection: KIOSK_AUTH_ABUSE fired and ticketed from the gateway events (no PIN, code or IP in the signal)')

        # --- Containment and revocation --------------------------------------------------------------------
        revoked = canary_mod.Gateway(edge + '/gateway/kiosk').post('revoke', tenant['owner']['token'], {
            'organization_id': tenant['org'], 'request_id': str(__import__('uuid').uuid4()), 'device_id': stolen['id']},
            'kiosk.revoke', None, mutation=True)
        mark('t2_contained')
        check(revoked.get('active') is False, 'IR containment: the OWNER revoked the stolen device through the edge')
        status, _, _ = authenticate(edge, attacker, tenant['org'], stolen['id'], people[1]['code'], people[1]['pin'])
        check(status == 403, 'IR revocation effective at once: the still-valid stolen JWT fails even with a correct code + PIN')
        check(api.get(f'/rest/v1/time_events?select=id&organization_id=eq.{tenant["org"]}', attacker) == []
              and api.get(f'/rest/v1/employees?select=id&organization_id=eq.{tenant["org"]}', attacker) == [],
              'IR the kiosk identity never had read access to records or the directory')

        # --- Evidence preservation (hashes, no PII) --------------------------------------------------------
        evidence = suite.scratch / 'evidence'
        evidence.mkdir(mode=0o700)
        audit = api.get(f'/rest/v1/audit_log?select=action,entity_type,actor_kind,server_at&organization_id=eq.{tenant["org"]}'
                        '&action=in.(kiosk_provision,kiosk_revoke)&order=server_at', tenant['owner']['token'])
        (evidence / 'audit-kiosk.json').write_text(json.dumps(audit, sort_keys=True))
        (evidence / 'gateway-events.jsonl').write_text('\n'.join(json.dumps(e, sort_keys=True) for e in gateway_events(T['t0_attack'])))
        (evidence / 'alerts.json').write_text(json.dumps(sink.received, sort_keys=True))
        manifest = {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(evidence.iterdir())}
        (evidence / 'MANIFEST.json').write_text(json.dumps({'collected_at': datetime.now(timezone.utc).isoformat(), 'sha256': manifest}))
        mark('t3_evidence')
        check([a['action'] for a in audit][-1] == 'kiosk_revoke' and len(manifest) == 3, 'IR evidence preserved with SHA-256 manifest')
        leaks = leak_scan(suite, [evidence])
        check(leaks == [], 'IR evidence carries no PIN, password, token, email, code or IP')

        # --- Affected-scope assessment ---------------------------------------------------------------------
        created = one('select count(*) from public.time_events where kiosk_device_id=%s and server_at >= to_timestamp(%s)',
                      (stolen['id'], T['t0_attack']))
        device_bucket = one('select max(failures) from private.auth_attempt_buckets where device_id=%s', (stolen['id'],))
        network_failures = one('select coalesce(max(failures),0) from private.kiosk_network_buckets where organization_id=%s', (tenant['org'],))
        check(created == 0 and labour_digest(tenant['org']) == baseline, 'IR assessment: no labour record created, altered or deleted')
        check(device_bucket >= 30 and network_failures < 60, 'IR assessment: device limit (30) stopped the guessing before the shared network limit (60)')
        status, _, offer = authenticate(edge, legit['token'], tenant['org'], legit['id'], people[1]['code'], people[1]['pin'])
        check(status == 200, 'IR assessment: the legitimate kiosk of the tenant kept working during the incident')
        mark('t4_assessed')

        # --- Recovery: replacement device ------------------------------------------------------------------
        replacement = admin.provision(api, tenant['owner']['token'], tenant['org'])
        suite.remember(replacement['password'])
        gw = canary_mod.Gateway(edge + '/gateway/kiosk')
        for action in ('CLOCK_IN', 'CLOCK_OUT'):
            offer = gw.post('authenticate', replacement['token'], {'organization_id': tenant['org'], 'device_id': replacement['id'],
                            'code': people[2]['code'], 'pin': people[2]['pin']}, 'kiosk.authenticate', None, mutation=False)
            challenge = next(c for c in offer['challenges'] if c['action'] == action)
            gw.post('record', replacement['token'], {'organization_id': tenant['org'], 'device_id': replacement['id'],
                    'request_id': challenge['request_id'], 'challenge': challenge['challenge'], 'action': action,
                    'expected_version': offer['version']}, f'clock.{action}', challenge['request_id'], True)
        mark('t5_recovered')
        check(True, 'IR recovery: replacement kiosk provisioned and used for a full cycle')

        # --- Credential rotation of the ingress secret without downtime ----------------------------------------
        probes = []

        def probe():
            probes.append(http('GET', edge + '/gateway/kiosk/health/ready')[0])
        processes.stop()   # functions and edge restart below; each step is followed by a probe window
        start_functions(processes, fenv(FICHAJE_INGRESS_SECRET=s2, FICHAJE_INGRESS_SECRET_PREVIOUS=s1), KIOSK_PORT, EXPORT_PORT, tag='fn-2')
        edge = start_edge(processes, suite.scratch, dist, EDGE_PORT, {**upstreams, 'FICHAJE_INGRESS_SECRET': s1}, tag='edge-2')
        probe()
        check(probes[-1] == 200, 'IR rotation step 1: functions accept the new and the previous secret; old edge still served')
        processes.stop(processes.children[-1])
        edge = start_edge(processes, suite.scratch, dist, EDGE_PORT, {**upstreams, 'FICHAJE_INGRESS_SECRET': s2}, tag='edge-3')
        probe()
        check(probes[-1] == 200, 'IR rotation step 2: edge signs with the new secret')
        for child in list(processes.children)[:2]:
            processes.stop(child)
        start_functions(processes, fenv(FICHAJE_INGRESS_SECRET=s2), KIOSK_PORT, EXPORT_PORT, tag='fn-3')
        probe()
        now = int(time.time())
        old_signed = http('GET', f'http://127.0.0.1:{KIOSK_PORT}/health/live', {'x-fichaje-edge': sign(s1, now, 'GET', 'kiosk', 'health/live', b'')})[0]
        new_signed = http('GET', f'http://127.0.0.1:{KIOSK_PORT}/health/live', {'x-fichaje-edge': sign(s2, now, 'GET', 'kiosk', 'health/live', b'')})[0]
        mark('t6_rotated')
        check(probes[-1] == 200 and old_signed == 403 and new_signed == 200, 'IR rotation step 3: the retired secret is refused; the new one works')

        # --- Resolution, notification decision, authorized reopening -----------------------------------------
        quiet = engine.process({'metrics': metrics.rates(gateway_events(T['t5_recovered']), 'kiosk-gateway')})
        check(sink.find('KIOSK_AUTH_ABUSE', 'RESOLVED') and [n['status'] for n in quiet] == ['RESOLVED'], 'IR alert resolved after recovery')
        decision = {'personal_data_breach': False,
                    'reason': 'sin acceso a datos personales: la credencial robada no superó ningún PIN, el dispositivo no tiene lectura de '
                              'registros ni directorio y no se creó, alteró ni borró ningún fichaje; disponibilidad preservada',
                    'processor_to_controller': 'aviso de incidente de seguridad a la empresa según contrato (sin violación de datos)',
                    'supervisory_authority': 'no procede según la valoración sintética del responsable (art. 33 RGPD)'}
        mark('t7_decided')
        summary = invariants.summary(monitor_dsn)
        critical = [x for x in summary['summary'] if x['severity'] == 'CRITICAL' and x['findings'] > 0]
        canary_state = canary_mod.Provisioner(api, S['service'], OPERATOR, canary_mod.Gateway(edge + '/gateway/kiosk')).provision()
        suite.remember(canary_state['tenant']['owner']['password'], canary_state['tenant']['worker']['password'],
                       canary_state['kiosk']['device_password'], canary_state['kiosk']['pin'], canary_state['kiosk']['private_key'])
        canary = canary_mod.Canary(canary_state, api, canary_mod.Gateway(edge + '/gateway/kiosk')).run()
        mark('t8_reopened')
        check(critical == [] and canary['status'] == 'PASS', 'IR authorized reopening: invariants without CRITICAL findings and canary PASS')
        check(one('select count(*) from public.audit_log where organization_id=%s', (tenant['org'],)) > audit_before,
              'IR every containment and recovery action is in the tenant audit')
        base = T['t0_attack']
        report = {'scenario': 'IR-01 kiosk credential stolen + ingress secret rotation',
                  'timeline_s': {k: round(v - base, 1) for k, v in sorted(T.items())},
                  'attack_attempts': 35, 'device_bucket_failures': device_bucket, 'network_bucket_failures': network_failures,
                  'labour_records_affected': 0, 'decision': decision, 'evidence_files': sorted(manifest)}
    finally:
        processes.stop()
        sink.__exit__()
        drop_logins('kiosk_h7_ir', 'ops_monitor_ir')
        (suite.scratch / 'report.json').write_text(json.dumps(report, sort_keys=True, ensure_ascii=False))
    leaks = leak_scan(suite, [suite.scratch / 'logs', suite.scratch / 'ops-events.jsonl', suite.scratch / 'report.json', suite.scratch / 'alerts.json'])
    for source, rule in leaks:
        print(f'LEAK_PATTERN {rule} in {Path(source).name}', file=sys.stderr)
    check(leaks == [], 'IR logs, alerts and the drill report carry no secret or personal data')
    print('REPORT ' + json.dumps({'h7_incident': 'PASS', 'checks': suite.count, **report}, sort_keys=True, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        import traceback
        frames = [f'{Path(f.filename).name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__)]
        print(f'FAIL h7_incident after {suite.count} checks: {type(error).__name__} at {" > ".join(frames[-4:])}', file=sys.stderr)
        if isinstance(error, AssertionError):
            print(f'assertion: {error}', file=sys.stderr)
        sys.exit(1)

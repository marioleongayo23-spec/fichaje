"""H7 induced failure drill in the staging shape (local): release gate through the
real edge, real alert routes (PagerDuty Events v2 / GitHub Issues contracts on a
loopback emulator), promotion blocked, automatic rollback, recovery, resolution
and labour history untouched.

R1 (healthy) is promoted. R2 carries a real edge defect (it signs the wrong
route, so every function refuses it). The unchanged OPS-02 gate must detect it,
page (CRITICAL) and ticket (WARNING), refuse the promotion, redeploy R1, see
health and canary green again and resolve every alert. Synthetic data only;
this repeats RES-02 with the H7 topology; the remote staging run is an operator
step with PlatformDeployer.
"""
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'ops'))
from h7_support import (OPERATOR, ROOT, WRANGLER, Suite, canary_mod, drop_logins, leak_scan, login, one, reset_opslog, rows,  # noqa: E402
                        secret_b64, stack)
import route_receiver  # noqa: E402

os.environ['OPS_FAULT_INJECTION'] = '1'
import alerts  # noqa: E402
import deployers  # noqa: E402
import faults  # noqa: E402
import health  # noqa: E402
import invariants  # noqa: E402
import opslib  # noqa: E402
import release_gate  # noqa: E402

suite = Suite('h7-release')
check = suite.check
S = stack()
suite.remember(S['service'])
api = canary_mod.Api(S['url'], S['anon'])
reset_opslog(suite.scratch / 'ops-events.jsonl')
TABLES = [('public.time_events', 'id'), ('public.work_sessions', 'id'), ('public.event_adjustments', 'id'),
          ('public.correction_decisions', 'id'), ('public.correction_requests', 'id'), ('public.audit_log', 'id'),
          ('private.idempotency_records', 'key'), ('public.employees', 'id'), ('public.memberships', 'id')]


def history_rows() -> dict:
    """Per-row digest of labour evidence and identity rows (any UPDATE/DELETE changes it)."""
    snapshot = {}
    for table, key in TABLES:
        for row_key, org, digest in rows(f'select t.{key}::text, t.organization_id::text, md5(row_to_json(t)::text) from {table} t'):
            snapshot[(table, row_key)] = (org, digest)
    return snapshot


def ts(event: dict) -> float:
    return datetime.fromisoformat(event['ts'].replace('Z', '+00:00')).timestamp()


def main() -> None:
    receiver = route_receiver.Receiver()
    os.environ.update({'OPS_ALERT_ROUTE_PAGER': 'pagerduty', 'OPS_ALERT_ROUTE_TICKET': 'github-issues:ops-owner/fichaje-ops',
                       'OPS_PAGERDUTY_ROUTING_KEY': route_receiver.ROUTING_KEY, 'OPS_GITHUB_TOKEN': route_receiver.GITHUB_TOKEN,
                       'OPS_PAGERDUTY_EVENTS_URL': receiver.url + '/v2/enqueue', 'OPS_GITHUB_API_URL': receiver.url})
    suite.remember(route_receiver.ROUTING_KEY, route_receiver.GITHUB_TOKEN)
    engine = alerts.AlertEngine(suite.scratch / 'alerts-staging.json', environment='staging')
    check(isinstance(engine.notifiers['pager'][0], alerts.PagerDutyNotifier) and isinstance(engine.notifiers['ticket'][0], alerts.GitHubIssueNotifier),
          'ALERTS staging engine routes CRITICAL to the pager adapter and WARNING to the ticket adapter')
    monitor_dsn = login(suite, 'ops_monitor_h7', 'fichaje_ops_monitor')
    gateway_dsn = login(suite, 'kiosk_h7_release', 'fichaje_gateway')
    pepper, network, ingress = secret_b64(), secret_b64(), secret_b64()
    suite.remember(pepper, network, ingress)
    runtime = {'KIOSK_AUTH_URL': S['url'], 'KIOSK_ANON_KEY': S['anon'], 'KIOSK_AUTH_PROVISION_KEY': S['service'], 'KIOSK_DATABASE_URL': gateway_dsn,
               'KIOSK_PEPPER': pepper, 'KIOSK_NETWORK_SECRET': network, 'SUPABASE_URL': S['url'], 'SUPABASE_ANON_KEY': S['anon'],
               'SUPABASE_SERVICE_ROLE_KEY': S['service'], 'SUPABASE_DB_URL': OPERATOR, 'FICHAJE_ENV': 'ci'}
    deployer = deployers.EdgeLocalDeployer(suite.scratch / 'deploy', runtime, {'VITE_SUPABASE_URL': S['url'], 'VITE_SUPABASE_PUBLISHABLE_KEY': S['publishable']},
                                           {'app': 4288, 'kiosk': 8777, 'export_link': 8012}, ingress, WRANGLER)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    timeline = {}
    try:
        deployer.build('h7-r1', commit)
        manifest = json.loads((deployer.path('h7-r1') / 'release.json').read_text())
        check('pages/functions/gateway/[[path]].ts' in manifest['files'] and 'dist/_headers' in manifest['files']
              and not any('.dev.vars' in f for f in manifest['files']), 'RES-02/H7 immutable release = app + Pages Function + functions; no runtime secret inside')
        live = deployer.deploy('h7-r1')
        if not all(live.values()):
            print('liveness', live, [p.poll() for p in deployer.processes], file=sys.stderr)
        check(all(live.values()), 'RES-02/H7 R1 served by workerd in front of the signed functions (liveness only through the edge)')
        app = deployer.app_url
        targets = health.Targets(app_url=app, api_url=S['url'], anon_key=S['anon'], db_dsn=monitor_dsn,
                                 kiosk_url=app + '/gateway/kiosk', export_link_url=app + '/gateway/export-link')
        gateway = canary_mod.Gateway(app + '/gateway/kiosk')
        prov = canary_mod.Provisioner(api, S['service'], OPERATOR, gateway)
        state = prov.provision()
        suite.remember(state['tenant']['owner']['password'], state['tenant']['worker']['password'], state['kiosk']['device_password'],
                       state['kiosk']['pin'], state['kiosk']['code'], state['kiosk']['private_key'])
        can = canary_mod.Canary(state, api, gateway, provisioner=prov)
        gate_fn = lambda rid: release_gate.gate(rid, targets, can, app)  # noqa: E731
        first = release_gate.promote(deployer, 'h7-r1', gate_fn, engine)
        check(first['state'] == 'PROMOTED' and deployer.state()['healthy'] == ['h7-r1'], 'RES-02/H7 healthy R1 passes health, smoke, canary and gate')
        check(receiver.events == [] and receiver.issues == {}, 'ALERTS a healthy promotion pages and tickets nothing')
        canary_org = state['tenant']['org']
        before = history_rows()
        invariants_before = invariants.summary(monitor_dsn)

        deployer.build('h7-r2', commit)
        faults.break_release(deployer.path('h7-r2'), 'edge-signature-broken')
        timeline['candidate_deploy_started'] = time.time()
        outcome = release_gate.promote(deployer, 'h7-r2', gate_fn, engine)
        timeline['gate_returned'] = time.time()
        degraded, restored = outcome['gates']
        check(outcome['state'] == 'ROLLED_BACK' and outcome['current'] == 'h7-r1', 'FAILURE-DRILL (1) promotion of the defective R2 refused and rolled back to R1')
        check(deployer.state()['healthy'] == ['h7-r1'], 'FAILURE-DRILL (3) the defective release was never marked healthy (promotion blocked)')
        check(degraded['status'] == 'FAIL' and degraded['health']['checks']['kiosk_gateway']['status'] == 'DOWN'
              and degraded['health']['checks']['export_link']['status'] == 'DOWN' and degraded['canary']['channels']['kiosk']['status'] == 'FAIL'
              and degraded['canary']['channels']['web']['status'] == 'PASS',
              'FAILURE-DRILL (1) detection: health through the edge sees both functions refuse the broken signature; kiosk canary fails; web unaffected')
        pager = [(e['event_action'], e.get('payload', {}).get('class'), e['dedup_key']) for e in receiver.events]
        triggers = {c for a, c, _ in pager if a == 'trigger'}
        check({'KIOSK_GATEWAY_DOWN', 'CANARY_FAILED'} <= triggers and all(c in ('KIOSK_GATEWAY_DOWN', 'CANARY_FAILED') for c in triggers),
              'FAILURE-DRILL (2) CRITICAL alerts paged through the PagerDuty Events v2 adapter')
        tickets = {i['title'].split('] ', 2)[-1].split(' ')[0]: i for i in receiver.issues.values()}
        check({'EXPORT_LINK_DOWN', 'RELEASE_DEGRADED'} <= set(tickets), 'FAILURE-DRILL (2) WARNING alerts opened GitHub-issue tickets')
        check(restored['status'] == 'PASS' and restored['health']['status'] == 'UP' and restored['canary']['status'] == 'PASS',
              'FAILURE-DRILL (4)(5) rollback redeployed R1: health UP and canary PASS again through the edge')
        dedups = {d for a, _, d in pager if a == 'trigger'}
        resolved = {d for a, _, d in pager if a == 'resolve'}
        check(dedups and dedups == resolved, 'FAILURE-DRILL (6) every page resolved with its own dedup key after recovery')
        check(all(i['state'] == 'closed' for i in receiver.issues.values()) and engine.firing() == [] and engine.pending() == 0,
              'FAILURE-DRILL (6) every ticket closed, nothing firing, nothing left in the outbox')
        after = history_rows()
        changed = [k for k, v in before.items() if after.get(k) != v]
        foreign_new = [k for k in after.keys() - before.keys() if after[k][0] != canary_org]
        check(changed == [], 'FAILURE-DRILL (7) no pre-existing labour, audit, receipt or identity row changed or disappeared')
        check(foreign_new == [], 'FAILURE-DRILL (7) the only new rows belong to the synthetic canary tenant')
        invariants_after = invariants.summary(monitor_dsn)
        critical = lambda report: sorted(x['invariant'] for x in report['summary'] if x['severity'] == 'CRITICAL' and x['findings'] > 0)  # noqa: E731
        check(critical(invariants_after) == critical(invariants_before), 'FAILURE-DRILL (7) read-only invariants: no new CRITICAL finding')
        # Measured timeline from the operational events and the provider emulator (wall clock, this machine).
        events = [json.loads(line) for line in Path(opslib.LOG.path).read_text().splitlines()]
        gate_fail = min(ts(e) for e in events if e['operation'] == 'release.gate' and e.get('release_id') == 'h7-r2' and e['outcome'] == 'failure')
        rolled = min(ts(e) for e in events if e['operation'] == 'release.rollback' and e['outcome'] == 'success')
        first_page = min(e['_received_at'] for e in receiver.events if e['event_action'] == 'trigger')
        last_resolve = max(e['_received_at'] for e in receiver.events if e['event_action'] == 'resolve')
        base = timeline['candidate_deploy_started']
        timeline = {'detection_s': round(gate_fail - base, 1), 'first_page_s': round(first_page - base, 1),
                    'rollback_complete_s': round(rolled - base, 1), 'all_resolved_s': round(last_resolve - base, 1),
                    'total_s': round(timeline['gate_returned'] - base, 1)}
        check(timeline['detection_s'] <= timeline['first_page_s'] <= timeline['rollback_complete_s'] <= timeline['all_resolved_s'],
              'FAILURE-DRILL order: detection → alert → rollback → resolution')
    finally:
        deployer.stop()
        receiver.close()
        drop_logins('ops_monitor_h7', 'kiosk_h7_release')
    report = {'timeline': timeline, 'pages': len(receiver.events), 'tickets': len(receiver.issues)}
    (suite.scratch / 'report.json').write_text(json.dumps(report, sort_keys=True))
    scanned = [suite.scratch / 'deploy' / 'logs', suite.scratch / 'ops-events.jsonl', suite.scratch / 'alerts-staging.json', suite.scratch / 'report.json']
    tickets_text = json.dumps(receiver.issues).encode()
    pager_text = json.dumps([{k: v for k, v in e.items() if k != 'routing_key'} for e in receiver.events]).encode()
    findings = leak_scan(suite, scanned, {'tickets': tickets_text, 'pages': pager_text})
    for source, rule in findings:
        print(f'LEAK_PATTERN {rule} in {Path(source).name}', file=sys.stderr)
    check(findings == [], 'OBS-01/06 alerts, tickets, pages, events and logs carry no secret, credential, PII or record identifier')
    print(json.dumps({'h7_release': 'PASS', 'checks': suite.count, **report}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        import traceback
        frames = [f'{Path(f.filename).name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__)]
        print(f'FAIL h7_release after {suite.count} checks: {type(error).__name__} at {" > ".join(frames[-4:])}', file=sys.stderr)
        if isinstance(error, AssertionError):
            print(f'assertion: {error}', file=sys.stderr)
        sys.exit(1)

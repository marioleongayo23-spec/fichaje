"""H7 pilot load test on the local staging shape (synthetic tenants only).

2 companies × 100 employees with accounts (web) + 20 employees without email per
company (kiosk, 4 devices each), 20 concurrent requests, through the real
PostgREST/Auth and the real edge + signed functions. Kiosks run three phases:
pilot peak (all 8 kiosks busy with human pacing: p95 < 1 s asserted), saturation
(the same kiosks back-to-back) and 20 simultaneous authentications; the last two
are measured limits (correctness asserted, latency reported). Health, the synthetic
canary and a PostgreSQL sampler run during the load. A final phase floods the
browser telemetry RPC with invalid batches (SEC-OPS-01 residual risk) while
employees clock, to measure the impact the platform layer must absorb.
Numbers are local measurements (this machine, loopback): staging must repeat
them against Cloudflare + Supabase; they are not an SLA.
"""
import json
import secrets
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from h7_support import (OPERATOR, KioskAdmin, Processes, Suite, build_dist, canary_mod, drop_logins, functions_env, leak_scan, login,  # noqa: E402
                        one, reset_opslog, secret_b64, stack, start_edge, start_functions, uid)
import health  # noqa: E402
import jobs  # noqa: E402
import loadtest  # noqa: E402
from opslib import HttpError, http_json  # noqa: E402

suite = Suite('h7-load')
check = suite.check
S = stack()
suite.remember(S['service'])
api = canary_mod.Api(S['url'], S['anon'])
reset_opslog(suite.scratch / 'ops-events.jsonl')
processes = Processes(suite.scratch / 'logs')
KIOSK_PORT, EXPORT_PORT, EDGE_PORT = 8769, 8005, 8792
EMPLOYEES, KIOSK_PEOPLE, DEVICES, CONCURRENCY = 100, 20, 4, 20
# Human time at a physical kiosk: typing the code and the 8-digit PIN, then choosing the action.
KIOSK_PACE = (3.0, 1.0)


def provision_company(prov, admin: KioskAdmin, label: str) -> dict:
    owner = prov.account('owner')
    org = uid()
    owner['membership'] = prov.bootstrap(org, owner['id'])
    owner['token'] = api.token(owner['email'], owner['password'])
    suite.remember(owner['email'], owner['password'])
    policy = prov.rpc('create_work_policy', owner['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_timezone': 'Europe/Madrid',
                      'p_break_counts_as_work': False})['id']

    def worker(_):
        import hashlib
        person = prov.account('employee')
        token = secrets.token_hex(32)
        prov.rpc('create_invitation', owner['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_email': person['email'],
                 'p_role': 'EMPLOYEE', 'p_token_hash': hashlib.sha256(token.encode()).hexdigest()})
        person['token'] = api.token(person['email'], person['password'])
        membership = prov.rpc('accept_invitation', person['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_token': token})['id']
        person['employee'], person['code'] = prov.employee(org, owner['token'], membership, policy)
        suite.remember(person['email'], person['password'], person['code'])
        return person

    with ThreadPoolExecutor(8) as pool:
        workers = list(pool.map(worker, range(EMPLOYEES)))

    def kiosk_person(_):
        employee, code = prov.employee(org, owner['token'], None, policy)
        pin = admin.reset_pin(owner['token'], org, employee)
        suite.remember(code, pin)
        return {'employee': employee, 'code': code, 'pin': pin}

    with ThreadPoolExecutor(4) as pool:
        kiosk = list(pool.map(kiosk_person, range(KIOSK_PEOPLE)))
    devices = [admin.provision(api, owner['token'], org) for _ in range(DEVICES)]
    for d in devices:
        suite.remember(d['password'])
    return {'org': org, 'owner': owner, 'policy': policy, 'workers': workers, 'kiosk': kiosk, 'devices': devices, 'label': label}


def main() -> None:
    gateway_dsn = login(suite, 'kiosk_h7_load', 'fichaje_gateway')
    monitor_dsn = login(suite, 'ops_monitor_load', 'fichaje_ops_monitor')
    pepper, network, ingress = secret_b64(), secret_b64(), secret_b64()
    suite.remember(pepper, network, ingress)
    dist = build_dist(suite.scratch / 'dist', S['url'], S['publishable'], 'h7-load')
    start_functions(processes, functions_env(S, gateway_dsn, pepper, network, ingress, 'h7-load'), KIOSK_PORT, EXPORT_PORT)
    edge = start_edge(processes, suite.scratch, dist, EDGE_PORT, {'FICHAJE_KIOSK_UPSTREAM': f'http://127.0.0.1:{KIOSK_PORT}',
                                                                  'FICHAJE_EXPORT_LINK_UPSTREAM': f'http://127.0.0.1:{EXPORT_PORT}',
                                                                  'FICHAJE_INGRESS_SECRET': ingress})
    report = {'profile': {'companies': 2, 'employees_web': EMPLOYEES, 'employees_kiosk': KIOSK_PEOPLE, 'devices': DEVICES, 'concurrency': CONCURRENCY}}
    try:
        prov = canary_mod.Provisioner(api, S['service'], OPERATOR, canary_mod.Gateway(edge + '/gateway/kiosk'))
        admin = KioskAdmin(edge + '/gateway/kiosk')
        started = time.monotonic()
        companies = [provision_company(prov, admin, 'A'), provision_company(prov, admin, 'B')]
        report['provisioning_s'] = round(time.monotonic() - started, 1)
        check(all(len(c['workers']) == EMPLOYEES and len(c['kiosk']) == KIOSK_PEOPLE for c in companies),
              'LOAD 2 synthetic companies × 100 web employees + 20 kiosk employees provisioned through the real paths')
        canary_state = prov.provision()
        suite.remember(canary_state['tenant']['owner']['password'], canary_state['tenant']['worker']['password'],
                       canary_state['kiosk']['device_password'], canary_state['kiosk']['pin'], canary_state['kiosk']['private_key'])
        canary = canary_mod.Canary(canary_state, api, canary_mod.Gateway(edge + '/gateway/kiosk'), provisioner=prov)
        targets = health.Targets(app_url=edge, api_url=S['url'], anon_key=S['anon'], db_dsn=monitor_dsn,
                                 kiosk_url=edge + '/gateway/kiosk', export_link_url=edge + '/gateway/export-link')
        orgs = [c['org'] for c in companies]
        events_before = one('select count(*) from public.time_events where organization_id = any(%s::uuid[])', (orgs,))
        runner = loadtest.Api(S['url'], S['anon'])
        recorder = loadtest.Recorder()
        stop = threading.Event()
        health_results, canary_results = [], []
        sampler = loadtest.DbSampler(monitor_dsn)
        sampler.start()
        loadtest.background(stop, lambda: health.run(targets), 2.0, health_results)
        loadtest.background(stop, canary.run, 3.0, canary_results)

        # Phase 1: web fichajes with 20 concurrent requests (every 10th employee replays each confirmed request).
        replays: list[bool] = []
        jobs_web = [(lambda c=c, w=w, i=i: loadtest.web_employee(runner, recorder, c['org'], w, replays, 10, i))
                    for c in companies for i, w in enumerate(c['workers'])]
        t0 = time.monotonic()
        failures = loadtest.run_pool(CONCURRENCY, jobs_web)
        report['web_phase_s'] = round(time.monotonic() - t0, 1)
        # Phase 2a: kiosk pilot peak. Every physical kiosk (4 per company) is busy at once and serves one
        # person at a time with human pacing (KIOSK_PACE): ~1.6 identifications/s in total, more than all
        # 40 kiosk people of the profile arriving within one minute.
        def device_queue(company, index, target, pace):
            for person in company['kiosk'][index::DEVICES]:
                loadtest.kiosk_employee(edge, target, company['org'], company['devices'][index], person, pace)
        paced = loadtest.Recorder()
        jobs_paced = [(lambda c=c, d=d: device_queue(c, d, paced, KIOSK_PACE)) for c in companies for d in range(DEVICES)]
        t0 = time.monotonic()
        failures += loadtest.run_pool(len(jobs_paced), jobs_paced)
        report['kiosk_pilot_peak_phase_s'] = round(time.monotonic() - t0, 1)
        # Phase 2b: saturation, the same 8 kiosks driven back-to-back without human time. Argon2id
        # (19 MiB, t=2) runs on the gateway's single thread, so requests queue: measured limit, reported.
        saturated = loadtest.Recorder()
        jobs_kiosk = [(lambda c=c, d=d: device_queue(c, d, saturated, None)) for c in companies for d in range(DEVICES)]
        t0 = time.monotonic()
        failures += loadtest.run_pool(len(jobs_kiosk), jobs_kiosk)
        report['kiosk_saturation_phase_s'] = round(time.monotonic() - t0, 1)
        # Phase 2c: stress, 20 simultaneous kiosk authentications (more than the pilot's devices can
        # produce). Measured and reported as the known limit; correctness is still asserted.
        stress = loadtest.Recorder()
        jobs_stress = [(lambda c=c, p=p, i=i: loadtest.kiosk_employee(edge, stress, c['org'], c['devices'][i % DEVICES], p))
                       for c in companies for i, p in enumerate(c['kiosk'])]
        t0 = time.monotonic()
        failures += loadtest.run_pool(CONCURRENCY, jobs_stress)
        report['kiosk_stress_phase_s'] = round(time.monotonic() - t0, 1)
        # Phase 3: a whole-company export while the canary keeps running.
        today = datetime.now(timezone.utc).date().isoformat()
        owner = companies[0]['owner']
        job = recorder.timed('rpc.request_export', lambda: runner.rpc('request_export', owner['token'], {'p_organization_id': orgs[0],
                             'p_request_id': uid(), 'p_employee_id': None, 'p_start': today, 'p_end': today, 'p_timezone': 'Europe/Madrid'}))
        exported = recorder.timed('job.export', lambda: jobs.export_job(OPERATOR, S['url'], S['service']))
        link = recorder.timed('export.link', lambda: http_json('POST', edge + '/gateway/export-link', {'Authorization': 'Bearer ' + owner['token']},
                              json.dumps({'organization_id': orgs[0], 'job_id': job['job_id']}).encode(), 30)[1])
        suite.remember(link['url'])
        check(exported['outcome'] == 'success' and 1 <= link['expires_in'] <= 300, 'LOAD whole-company export generated and signed during the load')
        baseline = recorder.summary()

        # Phase 4: invalid telemetry flood (authenticated) while 20 employees clock a second cycle.
        flood_recorder, flood_stop, flood_counts = loadtest.Recorder(), threading.Event(), {'calls': 0, 'rejected': 0}
        metrics_before = one('select count(*) from private.ops_client_metrics')
        flooder = companies[1]['workers'][0]

        def flood():
            invalid = json.dumps({'p_batch': [{'operation': 'not.in.vocabulary', 'outcome': 'success', 'error_class': 'NONE', 'count': 1,
                                               'sum_ms': 1, 'buckets': [1] + [0] * 9}]}).encode()
            while not flood_stop.is_set():
                try:
                    http_json('POST', S['url'] + '/rest/v1/rpc/ops_ingest_client_metrics', {'apikey': S['anon'], 'Authorization': 'Bearer ' + flooder['token']},
                              invalid, 10)
                except HttpError:
                    flood_counts['rejected'] += 1
                flood_counts['calls'] += 1
        flooders = [threading.Thread(target=flood, daemon=True) for _ in range(10)]
        for thread in flooders:
            thread.start()
        second = [(lambda c=c, w=w, i=i: loadtest.web_employee(runner, flood_recorder, c['org'], w, [], 10 ** 9, 1))
                  for c in companies for i, w in enumerate(c['workers'][:10])]
        t0 = time.monotonic()
        failures += loadtest.run_pool(10, second)
        flood_seconds = time.monotonic() - t0
        flood_stop.set()
        for thread in flooders:
            thread.join(15)
        stop.set()
        sampler.stop_event.set()
        sampler.join(5)
        under_flood = flood_recorder.summary()

        events_after = one('select count(*) from public.time_events where organization_id = any(%s::uuid[])', (orgs,))
        expected_events = 4 * 2 * EMPLOYEES + 3 * 4 * 2 * KIOSK_PEOPLE + 4 * 20
        db = sampler.summary()
        report.update(latency=baseline, kiosk_pilot_peak=paced.summary(), kiosk_saturation_8_back_to_back=saturated.summary(),
                      kiosk_stress_20_simultaneous=stress.summary(), under_invalid_telemetry_flood=under_flood, db=db,
                      telemetry_flood={'calls': flood_counts['calls'], 'rejected': flood_counts['rejected'],
                                       'calls_per_s': round(flood_counts['calls'] / max(flood_seconds, 0.001), 1)},
                      canary_runs=len(canary_results), health_runs=len(health_results))
        check(failures == [], 'LOAD no failed employee sequence (no error, timeout or conflict for legitimate traffic)')
        check(events_after - events_before == expected_events, 'LOAD exactly one event per confirmed action (no duplicate, no loss)')
        check(replays and all(replays), 'LOAD idempotent replays under load returned the original receipts')
        for operation in ('clock.CLOCK_IN', 'clock.BREAK_START', 'clock.BREAK_END', 'clock.CLOCK_OUT', 'rpc.get_employee_state'):
            check(baseline[operation]['errors'] == 0 and baseline[operation]['p95_ms'] < 1000,
                  f'LOAD {operation} p95 {baseline[operation]["p95_ms"]} ms < 1 s with {CONCURRENCY} concurrent requests (local)')
        peak = report['kiosk_pilot_peak']
        for operation in ('kiosk.authenticate', 'kiosk.clock.CLOCK_IN', 'kiosk.clock.BREAK_START', 'kiosk.clock.BREAK_END', 'kiosk.clock.CLOCK_OUT'):
            check(peak[operation]['errors'] == 0 and peak[operation]['p95_ms'] < 1000,
                  f'LOAD {operation} p95 {peak[operation]["p95_ms"]} ms < 1 s at the pilot kiosk peak (8 kiosks with human pacing, local)')
        busy = report['kiosk_saturation_8_back_to_back']
        check(all(v['errors'] == 0 for v in busy.values()),
              f'LOAD kiosk saturation (8 kiosks back-to-back, no human time): no error; measured limit p95 authenticate '
              f'{busy["kiosk.authenticate"]["p95_ms"]} ms, record ≤ {max(v["p95_ms"] for k, v in busy.items() if k.startswith("kiosk.clock."))} ms')
        stressed = report['kiosk_stress_20_simultaneous']
        check(all(v['errors'] == 0 for v in stressed.values()),
              f'LOAD kiosk stress (20 simultaneous authentications): no error; measured limit p95 {stressed["kiosk.authenticate"]["p95_ms"]} ms')
        check(db.get('deadlocks_delta') == 0, 'LOAD no PostgreSQL deadlock under the pilot profile')
        check(db.get('max_connections_used', 10 ** 6) < 0.8 * db.get('max_connections', 1), 'LOAD connections below the saturation threshold')
        check(canary_results and all(r['status'] == 'PASS' for r in canary_results), 'LOAD synthetic canary PASS throughout the load (no interference)')
        check(health_results and all(r['status'] == 'UP' or r['status'] == 'DEGRADED' for r in health_results)
              and not any(r['status'] == 'DOWN' for r in health_results), 'LOAD health never DOWN during the load')
        check(one('select count(*) from private.ops_client_metrics') == metrics_before and flood_counts['rejected'] == flood_counts['calls'],
              'LOAD invalid telemetry flood: every call rejected, nothing written')
        check(under_flood['clock.CLOCK_IN']['errors'] == 0 and under_flood['clock.CLOCK_OUT']['errors'] == 0,
              'LOAD fichajes keep succeeding during the invalid telemetry flood')
    finally:
        processes.stop()
        drop_logins('kiosk_h7_load', 'ops_monitor_load')
        (suite.scratch / 'report.json').write_text(json.dumps(report, sort_keys=True))
        print('REPORT ' + json.dumps(report, sort_keys=True), flush=True)
    findings = leak_scan(suite, [suite.scratch / 'logs', suite.scratch / 'ops-events.jsonl', suite.scratch / 'report.json'])
    for source, rule in findings:
        print(f'LEAK_PATTERN {rule} in {Path(source).name}', file=sys.stderr)
    check(findings == [], 'LOAD no secret, credential, PII or identifier in logs, events or the report')
    print(json.dumps({'h7_load': 'PASS', 'checks': suite.count, **report}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        import traceback
        frames = [f'{Path(f.filename).name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__)]
        print(f'FAIL h7_load after {suite.count} checks: {type(error).__name__} at {" > ".join(frames[-4:])}', file=sys.stderr)
        if isinstance(error, AssertionError):
            print(f'assertion: {error}', file=sys.stderr)
        sys.exit(1)

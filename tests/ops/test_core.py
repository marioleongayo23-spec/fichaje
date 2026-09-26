"""OPS-02 unit tests: OBS-01 events, OBS-02 metrics, OBS-06 alerts, RES-01 retries.

Run: python3 -m unittest discover -s tests/ops
"""
import io
import json
import socket
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'ops'))
import opslib  # noqa: E402
from opslib import CONTRACT, EventLog, HttpError, OpsError, build_event, classify_exception, classify_http  # noqa: E402
import metrics  # noqa: E402
import retry  # noqa: E402
import alerts  # noqa: E402
import leakscan  # noqa: E402

UUID = '3f2b8a54-6c1d-4e8f-9a0b-1c2d3e4f5a6b'
opslib.LOG.path, opslib.LOG.stream = '', io.StringIO()  # keep test output readable


class Obs01Events(unittest.TestCase):
    def test_structure_correlation_and_required_fields(self):
        event = build_event('kiosk-gateway', 'clock.CLOCK_IN', 'success', request_id=UUID, duration_ms=12.3456, attempt=1)
        for key in CONTRACT['required_event_fields']:
            self.assertIn(key, event)
        self.assertEqual(event['request_id'], UUID)
        self.assertEqual(event['duration_ms'], 12.346)
        self.assertEqual(event['error_class'], 'NONE')
        self.assertRegex(event['ts'], r'Z$')

    def test_release_and_commit_from_environment(self):
        with unittest.mock.patch.dict('os.environ', {'FICHAJE_RELEASE': '0.0.0+abc1234', 'FICHAJE_COMMIT': 'a' * 40}):
            event = build_event('canary', 'canary.run', 'success')
        self.assertEqual((event['release'], event['commit']), ('0.0.0+abc1234', 'a' * 40))
        with unittest.mock.patch.dict('os.environ', {'FICHAJE_RELEASE': 'bad release!', 'FICHAJE_COMMIT': 'zz'}):
            event = build_event('canary', 'canary.run', 'success')
        self.assertEqual((event['release'], event['commit']), ('invalid', 'unknown'))

    def test_sanitization_drops_every_sensitive_or_unknown_field(self):
        event = build_event('web', 'clock.CLOCK_IN', 'failure', error_class='VERSION_CONFLICT',
                            email='person@example.invalid', pin='12345678', jwt='eyJ.x.y', reason='sick',
                            employee_id=UUID, payload={'a': 1}, message='select * from x where y=1',
                            request_id='not-a-uuid', stage='with space', status=9999, attempt=-1)
        self.assertEqual(set(event) - set(CONTRACT['event_fields']), set())
        for key in ('email', 'pin', 'jwt', 'reason', 'employee_id', 'payload', 'message', 'request_id', 'stage', 'status', 'attempt'):
            self.assertNotIn(key, event)
        self.assertEqual(event['error_class'], 'VERSION_CONFLICT')

    def test_contract_violations_fail_fast(self):
        for args in [('unknown', 'clock.CLOCK_IN', 'success'), ('web', 'employee.X', 'success'), ('web', 'select', 'meh')]:
            with self.assertRaises(ValueError):
                build_event(*args)

    def test_json_lines_and_leak_scan(self):
        stream = io.StringIO()
        log = EventLog(path='', stream=stream)
        log.emit('export-worker', 'job.export', 'failure', error_class='STORAGE_ERROR', attempt=2)
        line = stream.getvalue().strip()
        self.assertEqual(json.loads(line)['operation'], 'job.export')
        self.assertEqual(leakscan.scan({'log': line.encode()}), [])

    def test_exception_mapping_never_serializes_text(self):
        class FakeSqlError(Exception):
            sqlstate = '40001'
            diag = type('D', (), {'message_primary': 'VERSION_CONFLICT'})()
        class ParamError(Exception):
            sqlstate = '23505'
            diag = type('D', (), {'message_primary': 'duplicate key value (pin)=(12345678)'})()
        self.assertEqual(classify_exception(FakeSqlError()), 'VERSION_CONFLICT')
        self.assertEqual(classify_exception(ParamError()), 'INTERNAL')
        self.assertEqual(classify_exception(socket.timeout()), 'TIMEOUT')
        self.assertEqual(classify_exception(socket.timeout(), sent=True), 'UNKNOWN_OUTCOME')
        self.assertEqual(classify_exception(ConnectionRefusedError()), 'NETWORK')
        self.assertEqual(classify_exception(HttpError(503, 'UPSTREAM_5XX')), 'UPSTREAM_5XX')
        self.assertEqual(classify_http(409, {'error': 'VERSION_CONFLICT'}), 'VERSION_CONFLICT')
        self.assertEqual(classify_http(400, {'message': 'CLOCK_REGRESSION', 'code': '22023'}), 'CLOCK_REGRESSION')
        self.assertEqual(classify_http(400, {'message': 'duplicate key (email)=(a@b.c)'}), 'INVALID_INPUT')
        self.assertEqual(classify_http(503, {'error': 'RETRYABLE_TIMEOUT'}), 'RETRYABLE_TIMEOUT')
        self.assertEqual(classify_http(403, {'error': 'AUTH_FAILED'}), 'AUTH_FAILED')
        self.assertEqual(classify_http(502), 'UPSTREAM_5XX')

    def test_private_state_files_are_owner_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'state' / 'canary.json'
            opslib.write_private(path, '{}')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


class Obs02Metrics(unittest.TestCase):
    def test_expected_families_labels_and_aggregation(self):
        events = [build_event('kiosk-gateway', 'clock.CLOCK_IN', 'success', duration_ms=40),
                  build_event('kiosk-gateway', 'clock.CLOCK_IN', 'success', duration_ms=120),
                  build_event('kiosk-gateway', 'clock.CLOCK_IN', 'rejected', error_class='VERSION_CONFLICT', duration_ms=30),
                  build_event('kiosk-gateway', 'kiosk.authenticate', 'rejected', error_class='RATE_LIMITED', duration_ms=310)]
        reg = metrics.from_events(events)
        self.assertEqual(reg.value('fichaje_ops_events_total', component='kiosk-gateway', operation='clock.CLOCK_IN', outcome='success', error_class='NONE'), 2)
        self.assertEqual(reg.value('fichaje_ops_events_total', component='kiosk-gateway', operation='kiosk.authenticate', outcome='rejected', error_class='RATE_LIMITED'), 1)
        hist = reg.histogram('fichaje_ops_duration_ms', component='kiosk-gateway', operation='clock.CLOCK_IN')
        self.assertEqual((hist['count'], hist['sum'], hist['buckets'][0], hist['buckets'][2]), (3, 190.0, 2, 1))
        text = reg.render()
        self.assertIn('# TYPE fichaje_ops_events_total counter', text)
        self.assertIn('fichaje_ops_duration_ms_bucket{component="kiosk-gateway",operation="clock.CLOCK_IN",le="+Inf"} 3', text)
        self.assertEqual(text, metrics.from_events(events).render(), 'rendering is deterministic')

    def test_no_sensitive_or_unbounded_labels(self):
        reg = metrics.Registry()
        bad = [('fichaje_ops_events_total', {'component': 'web', 'operation': 'select', 'outcome': 'success', 'error_class': 'NONE', 'employee_id': UUID}),
               ('fichaje_ops_events_total', {'component': 'web', 'operation': UUID, 'outcome': 'success', 'error_class': 'NONE'}),
               ('fichaje_probe_up', {'check': 'person@example.invalid'}),
               ('fichaje_backup_ok', {'kind': 'repo', 'tenant': 'x'}),
               ('undeclared_metric', {})]
        for name, labels in bad:
            with self.assertRaises(metrics.MetricError):
                reg.inc(name, labels) if name != 'fichaje_probe_up' and name != 'fichaje_backup_ok' else reg.set(name, labels, 1)
        for name, spec in CONTRACT['metrics'].items():
            self.assertFalse(set(spec['labels']) & set(CONTRACT['forbidden_label_keys']), name)
            for enum_name in spec['labels'].values():
                self.assertLess(len(opslib.enum(enum_name)), 100, 'bounded label cardinality')

    def test_out_of_contract_lines_are_counted_not_labelled(self):
        reg = metrics.from_events([{'component': 'web', 'operation': 'person@example.invalid', 'outcome': 'success'}])
        self.assertEqual((reg.rejected, reg.render()), (1, ''))

    def test_report_gauges_never_show_not_configured_as_ok(self):
        reg = metrics.from_reports({'backup': {'repo': {'status': 'OK', 'age_seconds': 3600}, 'database': {'status': 'NOT_CONFIGURED', 'age_seconds': None}},
                                    'health': {'checks': {'postgres': {'status': 'DEGRADED', 'latency_ms': 1500,
                                               'saturation': {'connections_ratio': 0.5, 'lock_waiting': 1, 'deadlocks': 0}}}}})
        self.assertEqual(reg.value('fichaje_backup_ok', kind='repo'), 1)
        self.assertEqual(reg.value('fichaje_backup_ok', kind='database'), 0)
        self.assertEqual(reg.value('fichaje_probe_up', check='postgres'), 0.5)

    def test_client_rows_merge_histograms(self):
        rows = [{'operation': 'clock.CLOCK_IN', 'outcome': 'success', 'error_class': 'NONE', 'requests': 3,
                 'duration_sum_ms': 190.5, 'duration_buckets': [2, 1, 0, 0, 0, 0, 0, 0, 0, 0]},
                {'operation': 'clock.CLOCK_IN', 'outcome': 'unknown', 'error_class': 'TIMEOUT', 'requests': 1,
                 'duration_sum_ms': 15000, 'duration_buckets': [0, 0, 0, 0, 0, 0, 0, 0, 1, 0]}]
        reg = metrics.from_client_rows(rows)
        self.assertEqual(reg.value('fichaje_frontend_requests_total', operation='clock.CLOCK_IN', outcome='unknown', error_class='TIMEOUT'), 1)
        self.assertEqual(reg.histogram('fichaje_frontend_duration_ms', operation='clock.CLOCK_IN')['count'], 4)

    def test_rates_for_metric_alerts(self):
        events = [build_event('web', 'clock.CLOCK_IN', 'rejected', error_class='VERSION_CONFLICT') for _ in range(10)]
        events += [build_event('web', 'clock.CLOCK_IN', 'success') for _ in range(10)]
        events += [build_event('kiosk-gateway', 'clock.CLOCK_OUT', 'rejected', error_class='CLOCK_REGRESSION')]
        stats = metrics.rates(events)
        self.assertEqual((stats['web']['clock'], stats['web']['version_conflicts']), (20, 10))
        self.assertEqual(stats['kiosk-gateway']['clock_regressions'], 1)


class Res01Retries(unittest.TestCase):
    def policy(self):
        return retry.RetryPolicy(max_attempts=4, base_delay_ms=100, max_delay_ms=250, jitter=lambda: 1.0)

    def op(self, **kw):
        base = dict(component='canary', name='clock.CLOCK_IN', idempotent=True, mutation=True,
                    payload=json.dumps({'p_request_id': UUID}).encode(), key=UUID)
        base.update(kw)
        return retry.Operation(**base)

    def test_unknown_outcome_retried_with_same_key_and_payload(self):
        seen, sleeps = [], []

        def attempt(payload, n):
            seen.append(payload)
            if n == 1:
                raise socket.timeout()  # response lost after the request was sent
            return {'event_id': 'x'}
        self.assertEqual(retry.execute(self.op(), attempt, self.policy(), sleep=sleeps.append), {'event_id': 'x'})
        self.assertEqual(len(seen), 2)
        self.assertEqual(seen[0], seen[1], 'exact same bytes (same request_id) on retry')
        self.assertEqual(sleeps, [0.1])

    def test_backoff_capped_and_attempts_limited(self):
        calls, sleeps = [], []

        def attempt(payload, n):
            calls.append(n)
            raise HttpError(503, 'UPSTREAM_5XX')
        with self.assertRaises(retry.RetryExhausted) as ctx:
            retry.execute(self.op(), attempt, self.policy(), sleep=sleeps.append)
        self.assertEqual(calls, [1, 2, 3, 4])
        self.assertEqual(sleeps, [0.1, 0.2, 0.25])
        self.assertEqual(ctx.exception.last_class, 'UPSTREAM_5XX')

    def test_permanent_error_is_never_retried(self):
        for error in (HttpError(409, 'VERSION_CONFLICT'), HttpError(400, 'INVALID_TRANSITION'), HttpError(403, 'FORBIDDEN'),
                      HttpError(400, 'CLOCK_REGRESSION'), HttpError(400, 'IDEMPOTENCY_CONFLICT')):
            calls = []
            with self.assertRaises(retry.NotRetryable):
                retry.execute(self.op(), lambda p, n: calls.append(n) or (_ for _ in ()).throw(error), self.policy(), sleep=lambda s: None)
            self.assertEqual(calls, [1], error.error_class)

    def test_non_idempotent_or_keyless_mutation_runs_once(self):
        for op in (self.op(idempotent=False), self.op(key=None)):
            calls = []

            def attempt(payload, n):
                calls.append(n)
                raise socket.timeout()
            with self.assertRaises(retry.NotRetryable) as ctx:
                retry.execute(op, attempt, self.policy(), sleep=lambda s: None)
            self.assertEqual(calls, [1])
            self.assertEqual(ctx.exception.error_class, 'UNKNOWN_OUTCOME')

    def test_exhaustion_after_unknown_outcome_keeps_the_key(self):
        with self.assertRaises(retry.RetryExhausted) as ctx:
            retry.execute(self.op(), lambda p, n: (_ for _ in ()).throw(socket.timeout()), self.policy(), sleep=lambda s: None)
        self.assertTrue(ctx.exception.unknown_outcome)

    def test_circuit_breaker_opens_and_half_opens(self):
        clock = [0.0]
        breaker = retry.CircuitBreaker(failures=2, cooldown_ms=1000, clock=lambda: clock[0])
        failing = lambda p, n: (_ for _ in ()).throw(HttpError(503, 'UPSTREAM_5XX'))  # noqa: E731
        with self.assertRaises(retry.CircuitOpen):
            retry.execute(self.op(), failing, self.policy(), breaker, sleep=lambda s: None)
        self.assertEqual(breaker.state, 'OPEN')
        calls = []
        with self.assertRaises(retry.CircuitOpen):
            retry.execute(self.op(), lambda p, n: calls.append(n), self.policy(), breaker, sleep=lambda s: None)
        self.assertEqual(calls, [], 'open circuit makes no call')
        clock[0] = 2.0
        self.assertEqual(breaker.state, 'HALF_OPEN')
        self.assertEqual(retry.execute(self.op(), lambda p, n: 'ok', self.policy(), breaker, sleep=lambda s: None), 'ok')
        self.assertEqual(breaker.state, 'CLOSED')


class Obs06Alerts(unittest.TestCase):
    def signals(self, **overrides):
        base = {'health': {'status': 'UP', 'checks': {c: {'status': 'UP', 'latency_ms': 5} for c in CONTRACT['checks']}},
                'canary': {'status': 'PASS', 'channels': {'web': {'status': 'PASS'}, 'kiosk': {'status': 'PASS'}}},
                'invariants': {'summary': []},
                'backup': {'repo': {'status': 'OK', 'age_seconds': 3600}, 'database': {'status': 'NOT_CONFIGURED'}}}
        base.update(overrides)
        return base

    def test_catalog_covers_required_alerts_and_runbooks(self):
        required_critical = {'API_DOWN', 'AUTH_DOWN', 'POSTGRES_DOWN', 'CANARY_FAILED', 'INVARIANT_CRITICAL', 'BACKUP_MISSING',
                             'BACKUP_FAILED', 'BACKUP_STALE', 'BACKUP_UNVERIFIED', 'RECOVERY_JOURNAL_BLOCKED', 'RELEASE_DEGRADED_NO_ROLLBACK'}
        required_warning = {'ERROR_RATE_HIGH', 'LATENCY_HIGH', 'JOB_FAILED', 'RETRY_REPEATED', 'VERSION_CONFLICT_HIGH',
                            'CLOCK_REGRESSION', 'EXPORT_BACKLOG', 'RETENTION_OVERDUE', 'BACKUP_NEAR_STALE'}
        catalog = CONTRACT['alerts']
        self.assertTrue(all(catalog[a]['severity'] == 'CRITICAL' for a in required_critical))
        self.assertTrue(all(catalog[a]['severity'] == 'WARNING' for a in required_warning))
        runbooks = (Path(__file__).resolve().parents[2] / 'docs' / 'RUNBOOKS.md').read_text(encoding='utf-8')
        anchors = set(re.findall(r'<a id="([a-z-]+)"></a>', runbooks))
        for name, spec in catalog.items():
            targets = [spec['runbook']] + [t for m in spec.get('runbook_by_label', {}).values() for t in m.values()]
            for target in targets:
                self.assertIn(target.split('#')[1], anchors, name)

    def test_routing_lifecycle_and_format(self):
        with tempfile.TemporaryDirectory() as tmp, alerts.TestSink() as sink:
            routes = {'pager': [alerts.Notifier(sink.url + '/pager')], 'ticket': [alerts.Notifier(sink.url + '/ticket')]}
            engine = alerts.AlertEngine(Path(tmp) / 'state.json', routes, environment='ci')
            first = engine.process(self.signals())
            self.assertEqual([n['alert'] for n in first], ['DB_BACKUP_NOT_CONFIGURED'], 'DB backup is never presented as green')
            down = self.signals(health={'status': 'DOWN', 'checks': {**{c: {'status': 'UP'} for c in CONTRACT['checks']},
                                                                  'postgres': {'status': 'DOWN', 'error_class': 'DB_UNAVAILABLE'}}},
                                canary={'status': 'FAIL', 'channels': {'web': {'status': 'FAIL', 'failed_step': 'clock.BREAK_START', 'error_class': 'FORBIDDEN'},
                                                                       'kiosk': {'status': 'PASS'}}})
            fired = engine.process(down)
            self.assertEqual(sorted(n['alert'] for n in fired), ['CANARY_FAILED', 'POSTGRES_DOWN'])
            self.assertEqual(engine.process(down), [], 'no duplicate notifications while firing')
            resolved = engine.process(self.signals())
            self.assertEqual(sorted((n['alert'], n['status']) for n in resolved), [('CANARY_FAILED', 'RESOLVED'), ('POSTGRES_DOWN', 'RESOLVED')])
            self.assertEqual(len(sink.find('POSTGRES_DOWN', 'FIRING', check='postgres')), 1)
            self.assertEqual(sink.find('POSTGRES_DOWN', 'FIRING')[0]['route'], 'pager')
            self.assertEqual(sink.find('DB_BACKUP_NOT_CONFIGURED', 'FIRING')[0]['route'], 'ticket')
            self.assertEqual(sink.find('CANARY_FAILED', 'RESOLVED')[0]['context'], {'error_class': 'FORBIDDEN', 'operation': 'clock.BREAK_START'},
                             'resolution keeps the stable context of the incident')
            self.assertEqual(sink.rejected, 0)
            blob = json.dumps(sink.received).encode()
            self.assertEqual(leakscan.scan({'alerts': blob}), [])

    def test_partial_signals_do_not_resolve_other_sources(self):
        with tempfile.TemporaryDirectory() as tmp:
            engine = alerts.AlertEngine(Path(tmp) / 's.json', {}, environment='ci')
            engine.process({'canary': {'status': 'FAIL', 'channels': {'kiosk': {'status': 'FAIL', 'error_class': 'TIMEOUT'}}}})
            self.assertEqual(engine.process({'health': self.signals()['health']}), [])
            self.assertEqual([a['alert'] for a in engine.firing()], ['CANARY_FAILED'])

    def test_production_escalates_missing_db_backup(self):
        self.assertEqual(alerts.severity('DB_BACKUP_NOT_CONFIGURED', 'production'), 'CRITICAL')
        self.assertEqual(alerts.severity('DB_BACKUP_NOT_CONFIGURED', 'ci'), 'WARNING')

    def test_rules_for_jobs_journal_release_backups_and_metrics(self):
        _, active = alerts.evaluate({
            'jobs': {'export': {'outcome': 'failure', 'attempts': 3, 'error_class': 'STORAGE_ERROR'}},
            'journal': {'status': 'BLOCKED'},
            'release': {'state': 'NO_ROLLBACK'},
            'backup': {'repo': {'status': 'STALE'}},
            'invariants': {'summary': [{'invariant': 'PROJECTION_DRIFT', 'severity': 'CRITICAL', 'findings': 1},
                                       {'invariant': 'EXPORT_JOB_STATE', 'severity': 'WARNING', 'findings': 2}]},
            'metrics': {'web': {'total': 40, 'errors': 10, 'clock': 40, 'version_conflicts': 20, 'clock_regressions': 1, 'retries': 0, 'p95_ms': 3000}}})
        names = sorted(a['alert'] for a in active)
        self.assertEqual(names, sorted(['JOB_FAILED', 'RETRY_REPEATED', 'RECOVERY_JOURNAL_BLOCKED', 'RELEASE_DEGRADED_NO_ROLLBACK',
                                        'BACKUP_STALE', 'INVARIANT_CRITICAL', 'EXPORT_BACKLOG', 'ERROR_RATE_HIGH',
                                        'VERSION_CONFLICT_HIGH', 'CLOCK_REGRESSION', 'SLOW_OPERATIONS']))
        self.assertEqual(alerts.runbook('JOB_FAILED', {'job': 'retention'}), 'docs/RUNBOOKS.md#retention-worker-failure')

    def test_invalid_payloads_rejected(self):
        with self.assertRaises(ValueError):
            alerts.condition('CANARY_FAILED', channel='person@example.invalid')
        with self.assertRaises(ValueError):
            alerts.validate_payload({'schema': 'fichaje.alert.v1', 'status': 'FIRING', 'alert': 'API_DOWN', 'email': 'x'})


class LeakScanner(unittest.TestCase):
    def test_generic_and_known_values(self):
        dirty = b'{"note":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXN5bnRoZXRpYw","who":"ana@example.invalid"}'
        rules = {rule for _, rule in leakscan.scan({'x': dirty})}
        self.assertTrue({'jwt', 'email'} <= rules)
        self.assertIn(('y', 'known-sensitive-value'), leakscan.scan({'y': b'pin=73920184'}, known=['73920184']))
        self.assertEqual(leakscan.scan({'z': b'SELECT a, b FROM t WHERE c=1'}, rules=['sql-text']), [('z', 'sql-text')])
        self.assertEqual(leakscan.scan({'ok': b'{"operation":"select","outcome":"success"}'}), [])


import re  # noqa: E402
import unittest.mock  # noqa: E402

if __name__ == '__main__':
    unittest.main()

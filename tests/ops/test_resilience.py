"""OPS-02 resilience units: RES-02 promotion/rollback decisions, RES-04 backup
evaluation, the SPA-aware application probe and fault-injection guards.
The real stack, real faults and real artefacts are exercised by
tests/integration/ops02.py; these tests pin the decision logic."""
import io
import json
import os
import sys
import tempfile
import threading
import unittest
import zipfile
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'ops'))
import opslib  # noqa: E402

opslib.LOG.path, opslib.LOG.stream = '', io.StringIO()

import alerts  # noqa: E402
import backup_monitor  # noqa: E402
import faults  # noqa: E402
import health  # noqa: E402
import release_gate  # noqa: E402
from opslib import OpsError  # noqa: E402

NOW = datetime(2026, 9, 26, 12, 0, tzinfo=timezone.utc)


class FakeDeployer:
    def __init__(self, current=None, healthy=()):
        self._state = {'current': current, 'healthy': list(healthy)}
        self.deployed = []

    def state(self):
        return json.loads(json.dumps(self._state))

    def deploy(self, release_id):
        self.deployed.append(release_id)
        self._state['current'] = release_id
        return {'app': True}

    def mark_healthy(self, release_id):
        self._state['healthy'] = [r for r in self._state['healthy'] if r != release_id] + [release_id]


def gate(results):
    up = {'status': 'UP', 'checks': {'app': {'status': 'UP', 'latency_ms': 1.0, 'error_class': 'NONE'}}}
    down = {'status': 'DOWN', 'checks': {'app': {'status': 'DOWN', 'latency_ms': 1.0, 'error_class': 'INVALID_RESPONSE'}}}

    def run(release_id):
        passed = results[release_id]
        return {'release_id': release_id, 'status': 'PASS' if passed else 'FAIL', 'health': up if passed else down,
                'synthetic': {'status': 'PASS', 'checks': {}}, 'canary': {'status': 'PASS', 'channels': {'web': {'status': 'PASS'}}}}
    return run


class Res02ReleaseGate(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.engine = alerts.AlertEngine(Path(self.tmp.name) / 'alerts.json', {}, 'ci')

    def tearDown(self):
        self.tmp.cleanup()

    def test_healthy_candidate_is_promoted(self):
        deployer = FakeDeployer('r1', ['r1'])
        outcome = release_gate.promote(deployer, 'r2', gate({'r2': True}), self.engine)
        self.assertEqual((outcome['state'], outcome['current'], deployer.deployed), ('PROMOTED', 'r2', ['r2']))
        self.assertEqual(deployer.state()['healthy'], ['r1', 'r2'])
        self.assertEqual(outcome['notifications'], [])

    def test_degraded_candidate_rolls_back_to_last_healthy_release_and_resolves(self):
        deployer = FakeDeployer('r1', ['r1'])
        outcome = release_gate.promote(deployer, 'r2', gate({'r2': False, 'r1': True}), self.engine)
        self.assertEqual((outcome['state'], outcome['current'], deployer.deployed), ('ROLLED_BACK', 'r1', ['r2', 'r1']))
        self.assertNotIn('r2', deployer.state()['healthy'])
        transitions = [(n['alert'], n['status']) for n in outcome['notifications']]
        self.assertIn(('RELEASE_DEGRADED', 'FIRING'), transitions)
        self.assertIn(('APP_DOWN', 'FIRING'), transitions)
        self.assertIn(('RELEASE_DEGRADED', 'RESOLVED'), transitions)
        self.assertIn(('APP_DOWN', 'RESOLVED'), transitions)
        self.assertEqual(self.engine.firing(), [])

    def test_no_healthy_release_escalates_critical(self):
        deployer = FakeDeployer(None, [])
        outcome = release_gate.promote(deployer, 'r1', gate({'r1': False}), self.engine)
        self.assertEqual(outcome['state'], 'NO_ROLLBACK')
        self.assertEqual(deployer.deployed, ['r1'])
        firing = {a['alert']: a['severity'] for a in self.engine.firing()}
        self.assertEqual(firing.get('RELEASE_DEGRADED_NO_ROLLBACK'), 'CRITICAL')

    def test_failed_rollback_is_never_reported_healthy(self):
        deployer = FakeDeployer('r1', ['r1'])
        outcome = release_gate.promote(deployer, 'r2', gate({'r2': False, 'r1': False}), self.engine)
        self.assertEqual((outcome['state'], deployer.deployed), ('NO_ROLLBACK', ['r2', 'r1']))
        self.assertIn('RELEASE_DEGRADED_NO_ROLLBACK', {a['alert'] for a in self.engine.firing()})

    def test_rollback_target_is_a_previously_healthy_release(self):
        deployer = FakeDeployer('r3', ['r1'])   # r3 was deployed but never passed the gate
        outcome = release_gate.promote(deployer, 'r4', gate({'r4': False, 'r1': True}), self.engine)
        self.assertEqual((outcome['state'], outcome['current']), ('ROLLED_BACK', 'r1'))

    def test_release_identifiers_are_bounded(self):
        deployer = release_gate.LocalDeployer(Path(self.tmp.name), {}, {}, {'app': 1, 'kiosk': 2, 'export_link': 3})
        for bad in ('../r1', 'r 1', '', 'x' * 65):
            with self.assertRaises(OpsError):
                deployer.path(bad)
        with self.assertRaises(OpsError):
            release_gate.LocalDeployer(Path(self.tmp.name), {'SUPABASE_URL': 'https://example.invalid'}, {}, {})


def runs(*items):
    return [{'id': 100 + i, 'status': 'completed', 'conclusion': c, 'updated_at': (NOW - timedelta(hours=h)).isoformat()}
            for i, (c, h) in enumerate(items)]


ARTIFACT = [{'id': 7, 'name': 'repository-100-1', 'size_in_bytes': 10, 'expired': False}]
VERIFIED = {'verified': True, 'restore_tested': True, 'error_class': 'NONE'}


class Res04Backups(unittest.TestCase):
    def test_repository_backup_states(self):
        evaluate = backup_monitor.evaluate_repo
        self.assertEqual(evaluate([], [], None, NOW)['status'], 'MISSING')
        self.assertEqual(evaluate(runs(('failure', 1), ('success', 3)), ARTIFACT, VERIFIED, NOW)['status'], 'FAILED')
        self.assertEqual(evaluate(runs(('success', 30)), ARTIFACT, VERIFIED, NOW)['status'], 'STALE')
        self.assertEqual(evaluate(runs(('success', 1)), [], None, NOW)['status'], 'MISSING')
        self.assertEqual(evaluate(runs(('success', 1)), [{**ARTIFACT[0], 'expired': True}], VERIFIED, NOW)['status'], 'MISSING')
        self.assertEqual(evaluate(runs(('success', 1)), ARTIFACT, None, NOW)['status'], 'UNVERIFIED')
        # Upload succeeded and checksums pass, but the restore rehearsal did not: never green.
        self.assertEqual(evaluate(runs(('success', 1)), ARTIFACT, {'verified': True, 'restore_tested': False}, NOW)['status'], 'UNVERIFIED')
        ok = evaluate(runs(('success', 1)), ARTIFACT, VERIFIED, NOW)
        self.assertEqual((ok['status'], ok['age_seconds']), ('OK', 3600))

    def test_database_backup_is_never_green_without_verified_restore(self):
        evaluate = backup_monitor.evaluate_db_manifest
        self.assertEqual(evaluate(None, NOW)['status'], 'NOT_CONFIGURED')
        base = {'result': 'success', 'completed_at': (NOW - timedelta(hours=2)).isoformat(), 'encrypted': True, 'ciphertext_sha256': 'a' * 64}
        self.assertEqual(evaluate({**base, 'result': 'failure'}, NOW)['status'], 'FAILED')
        self.assertEqual(evaluate({**base, 'completed_at': (NOW - timedelta(hours=40)).isoformat()}, NOW)['status'], 'STALE')
        self.assertEqual(evaluate({**base, 'encrypted': False}, NOW)['status'], 'UNVERIFIED')
        self.assertEqual(evaluate(base, NOW)['status'], 'UNVERIFIED')
        older = {'result': 'success', 'completed_at': (NOW - timedelta(hours=3)).isoformat()}
        self.assertEqual(evaluate({**base, 'restore_test': older}, NOW)['status'], 'UNVERIFIED')
        newer = {'result': 'success', 'completed_at': (NOW - timedelta(hours=1)).isoformat()}
        self.assertEqual(evaluate({**base, 'restore_test': newer}, NOW)['status'], 'OK')

    def test_database_backup_script_still_refuses(self):
        self.assertTrue(backup_monitor.database_backup_blocked())

    def test_artifact_path_traversal_is_rejected(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('../../escape.txt', b'x')
        result = backup_monitor.verify_artifact(buffer.getvalue())
        self.assertEqual((result['verified'], result['restore_tested']), (False, False))

    def test_monitor_report_feeds_alerts_and_gauges(self):
        report = {'repo': {'status': 'STALE', 'age_seconds': 30 * 3600}, 'database': {'status': 'NOT_CONFIGURED', 'age_seconds': None},
                  'generated_at': '2026-09-26T12:00:00.000Z'}
        _, active = alerts.evaluate({'backup': report})
        self.assertEqual(sorted(a['alert'] for a in active), ['BACKUP_STALE', 'DB_BACKUP_NOT_CONFIGURED'])
        import metrics
        registry = metrics.from_reports({'backup': report})
        self.assertEqual((registry.value('fichaje_backup_ok', kind='repo'), registry.value('fichaje_backup_ok', kind='database')), (0, 0))

    def test_summary_carries_statuses_only(self):
        report = {'repo': {'status': 'OK', 'age_seconds': 7200, 'verified': True, 'restore_tested': True, 'run_id': 123,
                           'artifact_digest': 'sha256:' + 'f' * 64},
                  'database': {'status': 'NOT_CONFIGURED', 'age_seconds': None, 'reason': 'DATABASE_BACKUP_BLOCKED_UNTIL_H7'}}
        text = backup_monitor.markdown(report)
        self.assertIn('| repo | OK |  | 2.0 | True | True |', text)
        self.assertIn('| database | NOT_CONFIGURED | DATABASE_BACKUP_BLOCKED_UNTIL_H7 |', text)
        self.assertNotIn('f' * 64, text)
        self.assertNotIn('123', text)


class SpaHost(BaseHTTPRequestHandler):
    """Mimics a static SPA host: unknown paths answer index.html with 200."""
    files = {'/': ('text/html', b'<!doctype html><div id="root"></div><script type="module" src="/assets/index-a.js"></script>'),
             '/assets/index-a.js': ('text/javascript', b'console.log(1)')}

    def log_message(self, *_):
        pass

    def do_GET(self):
        kind, body = self.files.get(self.path, self.files['/'])
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class Obs03ApplicationProbe(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), SpaHost)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()

    def test_complete_artifact_is_up(self):
        self.assertEqual(health.probe_app(self.url, 2), {})

    def test_missing_asset_answered_with_index_html_is_detected(self):
        SpaHost.files['/'] = ('text/html', SpaHost.files['/'][1].replace(b'index-a.js', b'index-missing.js'))
        try:
            with self.assertRaises(OpsError) as raised:
                health.probe_app(self.url, 2)
            self.assertEqual(raised.exception.error_class, 'INVALID_RESPONSE')
            report = health.run(health.Targets(app_url=self.url), 2000)
            self.assertEqual((report['status'], report['checks']['app']['status']), ('DOWN', 'DOWN'))
        finally:
            SpaHost.files['/'] = ('text/html', SpaHost.files['/'][1].replace(b'index-missing.js', b'index-a.js'))


class FaultInjectionGuards(unittest.TestCase):
    def test_requires_explicit_flag_and_loopback(self):
        previous = os.environ.pop('OPS_FAULT_INJECTION', None)
        try:
            with self.assertRaises(OpsError):
                faults.require_enabled('127.0.0.1')
            os.environ['OPS_FAULT_INJECTION'] = '1'
            faults.require_enabled('127.0.0.1', 'http://localhost:54321')
            for remote in ('db.example.com', 'https://project.supabase.co', '10.0.0.5'):
                with self.assertRaises(OpsError):
                    faults.require_enabled(remote)
            with self.assertRaises(OpsError):
                faults.container('stop', 'production_db')
            with self.assertRaises(ValueError):
                faults.disable_guard('postgresql://postgres:x@127.0.0.1:1/postgres', 'public.time_events; drop', 'immutable')
        finally:
            if previous is None:
                os.environ.pop('OPS_FAULT_INJECTION', None)
            else:
                os.environ['OPS_FAULT_INJECTION'] = previous


if __name__ == '__main__':
    unittest.main()

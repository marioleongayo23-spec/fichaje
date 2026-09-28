"""H7 real alert routes (CRITICAL → pager, WARNING → ticket) against local
receivers that implement the PagerDuty Events API v2 and GitHub Issues
contracts. Credentials come only from environment variable names; nothing
personal, secret or free-text leaves the engine."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'ops'))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import alerts  # noqa: E402
import opslib  # noqa: E402
from route_receiver import GITHUB_TOKEN, ROUTING_KEY, Receiver  # noqa: E402


class H7AlertRoutes(unittest.TestCase):
    def setUp(self):
        self.receiver = Receiver()
        self.tmp = Path(tempfile.mkdtemp())
        self.log = self.tmp / 'events.jsonl'
        opslib.LOG.path = str(self.log)
        self.env = mock.patch.dict(os.environ, {
            'OPS_ALERT_ROUTE_PAGER': 'pagerduty', 'OPS_ALERT_ROUTE_TICKET': 'github-issues:owner-x/private-repo',
            'OPS_PAGERDUTY_ROUTING_KEY': ROUTING_KEY, 'OPS_GITHUB_TOKEN': GITHUB_TOKEN,
            'OPS_PAGERDUTY_EVENTS_URL': self.receiver.url + '/v2/enqueue', 'OPS_GITHUB_API_URL': self.receiver.url})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        self.receiver.close()
        opslib.LOG.path = None

    def engine(self, environment='staging'):
        return alerts.AlertEngine(self.tmp / f'state-{environment}.json', environment=environment)

    def test_critical_pages_once_and_resolves_with_the_same_dedup_key(self):
        engine = self.engine()
        down = {'health': {'checks': {'kiosk_gateway': {'status': 'DOWN', 'error_class': 'UPSTREAM_5XX'}}}}
        engine.process(down)
        engine.process(down)                      # still firing: nothing new is sent
        engine.process({'health': {'checks': {'kiosk_gateway': {'status': 'UP'}}}})
        actions = [(e['event_action'], e['dedup_key']) for e in self.receiver.events]
        self.assertEqual(len(actions), 2)
        self.assertEqual(actions[0][0], 'trigger')
        self.assertEqual(actions[1], ('resolve', actions[0][1]))
        trigger = self.receiver.events[0]
        self.assertEqual(trigger['payload']['severity'], 'critical')
        self.assertEqual(trigger['payload']['class'], 'KIOSK_GATEWAY_DOWN')
        self.assertEqual(trigger['payload']['source'], 'fichaje-staging')
        self.assertEqual(trigger['payload']['custom_details']['runbook'], 'docs/RUNBOOKS.md#kiosk-gateway-down')
        self.assertEqual(self.receiver.issues, {}, 'a CRITICAL alert pages; it does not open a ticket')

    def test_warning_opens_one_ticket_and_closes_it_on_resolution(self):
        engine = self.engine()
        warn = {'invariants': {'summary': [{'invariant': 'OPEN_SESSION_STALE', 'severity': 'WARNING', 'findings': 2}]}}
        engine.process(warn)
        engine.process(warn)
        self.assertEqual(len(self.receiver.issues), 1)
        issue = self.receiver.issues[1]
        self.assertTrue(issue['title'].startswith('[WARNING][staging] INVARIANT_WARNING invariant=OPEN_SESSION_STALE ['))
        self.assertEqual(issue['labels'], ['fichaje-alert'])
        self.assertIn('docs/RUNBOOKS.md#invariant-drift', issue['body'])
        engine.process({'invariants': {'summary': []}})
        self.assertEqual(self.receiver.issues[1]['state'], 'closed')
        self.assertEqual(len(self.receiver.issues[1]['comments']), 1)
        self.assertIn('RESOLVED', self.receiver.issues[1]['comments'][0])
        self.assertEqual(self.receiver.events, [], 'a WARNING opens a ticket; it does not page')

    def test_redelivery_after_provider_failure_keeps_the_same_key_and_never_duplicates(self):
        engine = self.engine()
        self.receiver.fail_next = [503, 503, 503]        # the pager provider is down for one full delivery
        engine.process({'canary': {'channels': {'kiosk': {'status': 'FAIL', 'error_class': 'UPSTREAM_5XX'}}}})
        self.assertEqual(engine.pending(), 1, 'undelivered notification stays in the outbox')
        engine.process({'canary': {'channels': {'kiosk': {'status': 'FAIL', 'error_class': 'UPSTREAM_5XX'}}}})
        self.assertEqual(engine.pending(), 0)
        bodies = {r['raw'] for r in self.receiver.requests if r['path'] == '/v2/enqueue'}
        self.assertEqual(len(bodies), 1, 'every attempt sent the same frozen body (same dedup key)')
        self.assertEqual(len(self.receiver.events), 1)

    def test_credentials_never_reach_logs_state_or_ticket_text(self):
        engine = self.engine()
        engine.process({'health': {'checks': {'auth': {'status': 'DOWN', 'error_class': 'AUTH_UNAVAILABLE'}}},
                        'jobs': {'export': {'outcome': 'failure', 'error_class': 'STORAGE_ERROR', 'attempts': 1}}})
        state = (self.tmp / 'state-staging.json').read_text()
        events = self.log.read_text()
        tickets = json.dumps(self.receiver.issues)
        for text in (state, events, tickets):
            self.assertNotIn(ROUTING_KEY, text)
            self.assertNotIn(GITHUB_TOKEN, text)
        pager_bodies = [json.loads(r['raw']) for r in self.receiver.requests if r['path'] == '/v2/enqueue']
        for body in pager_bodies:
            flat = json.dumps({k: v for k, v in body.items() if k != 'routing_key'})
            for forbidden in ('email', 'employee', 'organization', 'tenant', 'pin', 'token', 'password', 'http'):
                self.assertNotIn(forbidden, flat.lower())
        self.assertEqual({r['headers'].get('Authorization') for r in self.receiver.requests if r['path'].startswith('/repos')},
                         {'Bearer ' + GITHUB_TOKEN}, 'the ticket token is only an Authorization header to the provider')

    def test_route_configuration_fails_closed(self):
        with mock.patch.dict(os.environ, {'OPS_PAGERDUTY_ROUTING_KEY': 'short'}):
            with self.assertRaisesRegex(ValueError, 'ALERT_ROUTE_CONFIG'):
                alerts.notifier_for('pagerduty', 'staging')
        with mock.patch.dict(os.environ, {'OPS_PAGERDUTY_EVENTS_URL': 'https://attacker.example/v2/enqueue'}):
            with self.assertRaisesRegex(ValueError, 'ALERT_ROUTE_CONFIG'):
                alerts.notifier_for('pagerduty', 'staging')
        with mock.patch.dict(os.environ, {'OPS_GITHUB_TOKEN': ''}):
            with self.assertRaisesRegex(ValueError, 'ALERT_ROUTE_CONFIG'):
                alerts.notifier_for('github-issues:owner/repo', 'production')
        for target in ('github-issues:not a repo', 'file:/tmp/sink.jsonl', 'http://example.com/hook', 'https://user:pw@example.com/x', 'smtp://x'):
            with self.assertRaisesRegex(ValueError, 'ALERT_ROUTE_CONFIG'):
                alerts.notifier_for(target, 'production')
        self.assertIsInstance(alerts.notifier_for('file:/tmp/sink.jsonl', 'ci'), alerts.Notifier)
        with mock.patch.dict(os.environ, {'OPS_ALERT_ROUTE_TICKET': ''}):
            with self.assertRaisesRegex(ValueError, 'ALERT_ROUTE_MISSING'):
                alerts.AlertEngine(self.tmp / 'prod.json', environment='production')


if __name__ == '__main__':
    unittest.main()

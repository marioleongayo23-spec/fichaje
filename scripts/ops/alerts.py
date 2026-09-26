"""OBS-06 alert contract: rules, routing, FIRING/RESOLVED lifecycle, notifiers.

Signals come from health, canary, invariants, backup, jobs, journal, release
and metric reports. Alerts carry only contract enumerations (alert name,
severity, stable labels), fixed summaries and runbook anchors: never tenant,
person, record, URL, credential or free text. The reproducible CI sink is a
local HTTP receiver; PagerDuty/Slack/email are routes to add in H7.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import CONTRACT, LOG, OpsError, enum, http_json, now_iso, release_info, write_private  # noqa: E402
from retry import Operation, RetryPolicy, execute  # noqa: E402

ALERTS = CONTRACT['alerts']
LABELS = CONTRACT['alert_labels']
THRESHOLDS = CONTRACT['thresholds']


def _clean(values: dict) -> dict:
    clean = {}
    for key, value in values.items():
        if key not in LABELS or value not in enum(LABELS[key]):
            raise ValueError('INVALID_ALERT_LABEL')
        clean[key] = value
    return clean


def condition(alert: str, context: dict | None = None, **labels) -> dict:
    """labels identify the alert (fingerprint); context only describes it."""
    if alert not in ALERTS:
        raise ValueError('UNKNOWN_ALERT')
    return {'alert': alert, 'labels': _clean(labels), 'context': _clean(context or {})}


def evaluate(signals: dict) -> tuple[set[str], list[dict]]:
    """Pure rules: (sources evaluated, active conditions)."""
    sources, active = set(), []
    health = signals.get('health')
    if health is not None:
        sources.add('health')
        names = {'app': 'APP_DOWN', 'api': 'API_DOWN', 'auth': 'AUTH_DOWN', 'postgres': 'POSTGRES_DOWN',
                 'kiosk_gateway': 'KIOSK_GATEWAY_DOWN', 'export_link': 'EXPORT_LINK_DOWN'}
        for check, result in health['checks'].items():
            if result['status'] == 'DOWN':
                active.append(condition(names[check], {'error_class': result.get('error_class', 'INTERNAL')}, check=check))
            elif result['status'] == 'DEGRADED':
                active.append(condition('LATENCY_HIGH', check=check))
            saturation = result.get('saturation')
            if saturation and (saturation['connections_ratio'] >= THRESHOLDS['db_connections_warning_ratio']
                               or saturation['lock_waiting'] >= THRESHOLDS['db_lock_waiting_warning']):
                active.append(condition('DB_SATURATION', check=check))
    canary = signals.get('canary')
    if canary is not None:
        sources.add('canary')
        for channel, result in canary['channels'].items():
            if result['status'] != 'PASS':
                context = {'error_class': result.get('error_class', 'INTERNAL')}
                if result.get('failed_step') in enum('operations'):
                    context['operation'] = result['failed_step']
                active.append(condition('CANARY_FAILED', context, channel=channel))
    invariants = signals.get('invariants')
    if invariants is not None:
        sources.add('invariants')
        for row in invariants['summary']:
            if row['findings'] <= 0:
                continue
            if row['severity'] == 'CRITICAL':
                active.append(condition('INVARIANT_CRITICAL', invariant=row['invariant']))
            elif row['severity'] == 'WARNING':
                name = {'EXPORT_JOB_STATE': 'EXPORT_BACKLOG', 'RETENTION_OVERDUE': 'RETENTION_OVERDUE'}.get(row['invariant'], 'INVARIANT_WARNING')
                active.append(condition(name, invariant=row['invariant']))
    backup = signals.get('backup')
    if backup is not None:
        sources.add('backup')
        for kind, result in backup.items():
            status = result['status']
            if status == 'NOT_CONFIGURED':
                active.append(condition('DB_BACKUP_NOT_CONFIGURED', kind=kind))
            elif status in ('STALE', 'FAILED', 'MISSING', 'UNVERIFIED'):
                active.append(condition('BACKUP_' + status, {'state': status}, kind=kind))
            elif status == 'OK' and result.get('age_seconds') is not None and \
                    result['age_seconds'] >= THRESHOLDS['backup_warn_age_hours'] * 3600:
                active.append(condition('BACKUP_NEAR_STALE', kind=kind))
    jobs = signals.get('jobs')
    if jobs is not None:
        sources.add('jobs')
        for job, result in jobs.items():
            if result['outcome'] != 'success':
                active.append(condition('JOB_FAILED', {'error_class': result.get('error_class', 'INTERNAL')}, job=job))
            if result.get('attempts', 1) >= THRESHOLDS['retry_repeated_attempts']:
                active.append(condition('RETRY_REPEATED', job=job))
    journal = signals.get('journal')
    if journal is not None:
        sources.add('journal')
        if journal['status'] != 'OK':
            active.append(condition('RECOVERY_JOURNAL_BLOCKED', {'state': journal['status']}))
    release = signals.get('release')
    if release is not None:
        sources.add('release')
        if release['state'] in ('DEGRADED', 'ROLLED_BACK_PENDING'):
            active.append(condition('RELEASE_DEGRADED'))
        elif release['state'] == 'NO_ROLLBACK':
            active.append(condition('RELEASE_DEGRADED_NO_ROLLBACK'))
    metrics = signals.get('metrics')
    if metrics is not None:
        sources.add('metrics')
        for component, stats in metrics.items():
            if stats['total'] >= THRESHOLDS['min_events_for_rates'] and stats['errors'] / stats['total'] >= THRESHOLDS['error_rate_warning']:
                active.append(condition('ERROR_RATE_HIGH', component=component))
            if stats['clock'] >= THRESHOLDS['min_events_for_rates'] and \
                    stats['version_conflicts'] / stats['clock'] >= THRESHOLDS['version_conflict_rate_warning']:
                active.append(condition('VERSION_CONFLICT_HIGH', component=component))
            if stats['clock_regressions'] > 0:
                active.append(condition('CLOCK_REGRESSION', component=component))
            if stats['total'] >= THRESHOLDS['min_events_for_rates'] and stats['p95_ms'] >= THRESHOLDS['slow_p95_ms']:
                active.append(condition('SLOW_OPERATIONS', component=component))
    return sources, active


def fingerprint(item: dict) -> str:
    raw = json.dumps([item['alert'], sorted(item['labels'].items())], separators=(',', ':'))
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def severity(alert: str, environment: str) -> str:
    spec = ALERTS[alert]
    return spec.get('production_severity', spec['severity']) if environment == 'production' else spec['severity']


def runbook(alert: str, labels: dict) -> str:
    spec = ALERTS[alert]
    for key, mapping in spec.get('runbook_by_label', {}).items():
        if labels.get(key) in mapping:
            return mapping[labels[key]]
    return spec['runbook']


class Notifier:
    """Webhook (JSON POST) or file (JSON lines). Retries use the alert's own
    idempotency key so a receiver can deduplicate (RES-01)."""

    def __init__(self, target: str):
        self.target = target

    def send(self, payload: dict) -> None:
        body = json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()
        if self.target.startswith('file:'):
            with open(self.target[5:], 'a', encoding='utf-8') as handle:
                handle.write(body.decode() + '\n')
            return
        key = payload['notification_id']
        execute(Operation('alerts', 'alert.notify', idempotent=True, mutation=True, payload=body, key=key),
                lambda data, _n: http_json('POST', self.target, {'Idempotency-Key': key}, data, timeout=5),
                RetryPolicy(max_attempts=3, base_delay_ms=100, max_delay_ms=500))


def notifiers_from_env() -> dict[str, list[Notifier]]:
    routes = {}
    for route in ('pager', 'ticket'):
        target = os.environ.get('OPS_ALERT_ROUTE_' + route.upper())
        routes[route] = [Notifier(target)] if target else []
    return routes


class AlertEngine:
    """Keeps FIRING alerts in a state file and emits transitions only."""

    def __init__(self, state_path: Path, notifiers: dict[str, list[Notifier]] | None = None, environment: str = 'ci'):
        if environment not in enum('environments'):
            raise ValueError('INVALID_ENVIRONMENT')
        self.state_path = Path(state_path)
        self.notifiers = notifiers if notifiers is not None else notifiers_from_env()
        self.environment = environment

    def _load(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text(encoding='utf-8'))
        return {'firing': {}}

    def process(self, signals: dict) -> list[dict]:
        sources, active = evaluate(signals)
        state = self._load()
        firing = state['firing']
        release, commit = release_info()
        sent = []
        current = {fingerprint(item): item for item in active}
        for fp, item in sorted(current.items()):
            if fp in firing:
                continue
            firing[fp] = {'alert': item['alert'], 'labels': item['labels'], 'context': item['context'],
                          'started_at': now_iso(), 'source': ALERTS[item['alert']]['source']}
            sent.append(self._notify('FIRING', fp, firing[fp], release, commit))
        for fp in sorted(list(firing)):
            entry = firing[fp]
            if entry['source'] in sources and fp not in current:
                sent.append(self._notify('RESOLVED', fp, entry, release, commit, resolved=True))
                del firing[fp]
        write_private(self.state_path, json.dumps(state, sort_keys=True))
        LOG.emit('alerts', 'alert.evaluate', 'success', count=len(sent))
        return sent

    def firing(self) -> list[dict]:
        return [{'alert': e['alert'], 'severity': severity(e['alert'], self.environment), 'labels': e['labels']}
                for e in self._load()['firing'].values()]

    def _notify(self, status: str, fp: str, entry: dict, release: str, commit: str, resolved: bool = False) -> dict:
        level = severity(entry['alert'], self.environment)
        payload = {
            'schema': 'fichaje.alert.v1', 'status': status, 'alert': entry['alert'], 'severity': level,
            'summary': ALERTS[entry['alert']]['summary'], 'runbook': runbook(entry['alert'], entry['labels']),
            'source': entry['source'], 'labels': entry['labels'], 'context': entry.get('context', {}), 'fingerprint': fp,
            'notification_id': hashlib.sha256(f'{fp}|{status}|{entry["started_at"]}'.encode()).hexdigest()[:32],
            'environment': self.environment, 'release': release, 'commit': commit,
            'started_at': entry['started_at'], 'resolved_at': now_iso() if resolved else None, 'sent_at': now_iso(),
        }
        validate_payload(payload)
        routes = CONTRACT['routes'][level] if level in CONTRACT['routes'] else []
        payload['routes'] = routes
        for route in routes:
            for notifier in self.notifiers.get(route, []):
                try:
                    notifier.send(payload)
                    LOG.emit('alerts', 'alert.notify', 'success', alert=entry['alert'], severity=level, state=status)
                except OpsError as error:
                    LOG.emit('alerts', 'alert.notify', 'failure', alert=entry['alert'], severity=level, state=status,
                             error_class=error.error_class)
        return payload


PAYLOAD_KEYS = {'schema', 'status', 'alert', 'severity', 'summary', 'runbook', 'source', 'labels', 'context', 'fingerprint',
                'notification_id', 'environment', 'release', 'commit', 'started_at', 'resolved_at', 'sent_at', 'routes'}


def validate_payload(payload: dict) -> None:
    """Format contract for every notification (also used by the test sink)."""
    import re
    extra = set(payload) - PAYLOAD_KEYS
    if extra or payload.get('schema') != 'fichaje.alert.v1' or payload.get('status') not in ('FIRING', 'RESOLVED'):
        raise ValueError('INVALID_ALERT_PAYLOAD')
    alert = payload.get('alert')
    if alert not in ALERTS or payload.get('severity') not in ('CRITICAL', 'WARNING') \
            or payload.get('summary') != ALERTS[alert]['summary'] or not str(payload.get('runbook', '')).startswith('docs/RUNBOOKS.md#'):
        raise ValueError('INVALID_ALERT_PAYLOAD')
    for key, value in list(payload.get('labels', {}).items()) + list(payload.get('context', {}).items()):
        if key not in LABELS or value not in enum(LABELS[key]):
            raise ValueError('INVALID_ALERT_PAYLOAD')
    if not re.match(r'^[0-9a-f]{24}$', payload.get('fingerprint', '')) or not re.match(r'^[0-9a-f]{32}$', payload.get('notification_id', '')):
        raise ValueError('INVALID_ALERT_PAYLOAD')
    if 'routes' in payload and not set(payload['routes']) <= {'pager', 'ticket'}:
        raise ValueError('INVALID_ALERT_PAYLOAD')


class TestSink:
    """Reproducible CI receiver: validates format, records by route, dedupes by id."""

    def __init__(self, port: int = 0):
        sink = self
        self.received: list[dict] = []
        self.rejected = 0
        self.lock = threading.Lock()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                route = self.path.strip('/')
                raw = self.rfile.read(int(self.headers.get('Content-Length', '0') or 0))
                try:
                    payload = json.loads(raw)
                    validate_payload(payload)
                    if route not in payload.get('routes', []):
                        raise ValueError('WRONG_ROUTE')
                except ValueError:
                    with sink.lock:
                        sink.rejected += 1
                    self.send_response(422)
                    self.end_headers()
                    return
                with sink.lock:
                    if not any(r['notification_id'] == payload['notification_id'] and r['route'] == route for r in sink.received):
                        sink.received.append({**payload, 'route': route})
                self.send_response(202)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{}')

        self.server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f'http://127.0.0.1:{self.server.server_port}'

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.server.shutdown()
        self.server.server_close()

    def find(self, alert: str, status: str, **labels) -> list[dict]:
        with self.lock:
            return [r for r in self.received if r['alert'] == alert and r['status'] == status
                    and all(r['labels'].get(k) == v for k, v in labels.items())]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Evaluate OPS-02 signals and route alerts')
    parser.add_argument('signals', help='JSON file with health/canary/invariants/backup/jobs/journal/release/metrics signals')
    parser.add_argument('--state', required=True, help='alert state file (never committed)')
    parser.add_argument('--environment', default='ci', choices=sorted(enum('environments')))
    args = parser.parse_args()
    engine = AlertEngine(Path(args.state), environment=args.environment)
    for notification in engine.process(json.loads(Path(args.signals).read_text(encoding='utf-8'))):
        print(json.dumps({k: notification[k] for k in ('status', 'alert', 'severity', 'labels', 'runbook')}, sort_keys=True))

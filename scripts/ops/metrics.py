"""OPS-02 metrics (OBS-02): log-based and report-based, Prometheus text format.

Label keys and values come exclusively from ops/contract.json enumerations, so
cardinality is bounded and no identifier (employee, event, request, tenant,
email) can ever become a label. Anything else is rejected, not truncated.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import CONTRACT, enum  # noqa: E402

BUCKETS = list(CONTRACT['duration_buckets_ms'])
FORBIDDEN_LABELS = frozenset(CONTRACT['forbidden_label_keys'])


class MetricError(ValueError):
    pass


class Registry:
    def __init__(self):
        self.values: dict[tuple, float] = {}
        self.histograms: dict[tuple, dict] = {}
        self.rejected = 0

    @staticmethod
    def _labels(name: str, labels: dict) -> tuple:
        spec = CONTRACT['metrics'].get(name)
        if spec is None:
            raise MetricError('UNKNOWN_METRIC')
        if set(labels) & FORBIDDEN_LABELS or set(labels) != set(spec['labels']):
            raise MetricError('INVALID_LABELS')
        for key, value in labels.items():
            if value not in enum(spec['labels'][key]):
                raise MetricError('INVALID_LABEL_VALUE')
        return (name, tuple(sorted(labels.items())))

    @staticmethod
    def _type(name: str) -> str:
        if name not in CONTRACT['metrics']:
            raise MetricError('UNKNOWN_METRIC')
        return CONTRACT['metrics'][name]['type']

    def inc(self, name: str, labels: dict, value: float = 1.0) -> None:
        if self._type(name) != 'counter' or value < 0:
            raise MetricError('NOT_A_COUNTER')
        key = self._labels(name, labels)
        self.values[key] = self.values.get(key, 0.0) + value

    def set(self, name: str, labels: dict, value: float) -> None:
        if self._type(name) not in ('gauge', 'counter') or not math.isfinite(value):
            raise MetricError('NOT_A_GAUGE')
        self.values[self._labels(name, labels)] = float(value)

    def observe(self, name: str, labels: dict, value_ms: float, count: int = 1) -> None:
        if self._type(name) != 'histogram' or value_ms < 0:
            raise MetricError('NOT_A_HISTOGRAM')
        key = self._labels(name, labels)
        entry = self.histograms.setdefault(key, {'buckets': [0] * (len(BUCKETS) + 1), 'sum': 0.0, 'count': 0})
        index = next((i for i, limit in enumerate(BUCKETS) if value_ms <= limit), len(BUCKETS))
        entry['buckets'][index] += count
        entry['sum'] += value_ms * count
        entry['count'] += count

    def merge_histogram(self, name: str, labels: dict, buckets: list[int], total_ms: float) -> None:
        """Pre-aggregated client histogram with the same bucket layout."""
        if len(buckets) != len(BUCKETS) + 1 or any((not isinstance(b, int)) or b < 0 for b in buckets):
            raise MetricError('INVALID_BUCKETS')
        key = self._labels(name, labels)
        entry = self.histograms.setdefault(key, {'buckets': [0] * (len(BUCKETS) + 1), 'sum': 0.0, 'count': 0})
        entry['buckets'] = [a + b for a, b in zip(entry['buckets'], buckets)]
        entry['sum'] += float(total_ms)
        entry['count'] += sum(buckets)

    def value(self, name: str, **labels) -> float:
        return self.values.get(self._labels(name, labels), 0.0)

    def histogram(self, name: str, **labels) -> dict | None:
        return self.histograms.get(self._labels(name, labels))

    def render(self) -> str:
        """Deterministic Prometheus text exposition (format 0.0.4)."""
        lines: list[str] = []
        names = sorted({k[0] for k in self.values} | {k[0] for k in self.histograms})
        for name in names:
            spec = CONTRACT['metrics'][name]
            lines.append(f'# HELP {name} {spec["help"]}')
            lines.append(f'# TYPE {name} {spec["type"]}')
            for (metric, labels), value in sorted(self.values.items()):
                if metric == name:
                    lines.append(f'{name}{_fmt(labels)} {_num(value)}')
            for (metric, labels), entry in sorted(self.histograms.items()):
                if metric != name:
                    continue
                cumulative = 0
                for limit, count in zip(BUCKETS + ['+Inf'], entry['buckets']):
                    cumulative += count
                    lines.append(f'{name}_bucket{_fmt(labels + (("le", str(limit)),))} {cumulative}')
                lines.append(f'{name}_sum{_fmt(labels)} {_num(entry["sum"])}')
                lines.append(f'{name}_count{_fmt(labels)} {entry["count"]}')
        return '\n'.join(lines) + ('\n' if lines else '')


def _fmt(labels: tuple) -> str:
    return '{' + ','.join(f'{k}="{v}"' for k, v in labels) + '}' if labels else ''


def _num(value: float) -> str:
    return str(int(value)) if float(value).is_integer() else repr(round(value, 6))


def from_events(events, registry: Registry | None = None) -> Registry:
    """Counters and latency histograms from OBS-01 events."""
    registry = registry or Registry()
    for event in events:
        labels = {'component': event['component'], 'operation': event['operation']}
        try:
            registry.inc('fichaje_ops_events_total', {**labels, 'outcome': event['outcome'], 'error_class': event.get('error_class', 'NONE')})
            if isinstance(event.get('duration_ms'), (int, float)):
                registry.observe('fichaje_ops_duration_ms', labels, event['duration_ms'])
        except MetricError:
            # A line outside the contract never becomes a label; it is only counted.
            registry.rejected += 1
    return registry


def from_client_rows(rows, registry: Registry | None = None) -> Registry:
    """Aggregated browser telemetry read by the ops monitor role. Untrusted
    (SEC-OPS-01): any authenticated client shapes it within server quotas, so it
    is exposed for dashboards only and never feeds rates(), alerts, the release
    gate or a repair."""
    registry = registry or Registry()
    for row in rows:
        registry.inc('fichaje_frontend_requests_total', {'operation': row['operation'], 'outcome': row['outcome'],
                                                        'error_class': row['error_class']}, row['requests'])
        registry.merge_histogram('fichaje_frontend_duration_ms', {'operation': row['operation']},
                                 list(row['duration_buckets']), row['duration_sum_ms'])
    return registry


def from_reports(reports: dict, registry: Registry | None = None) -> Registry:
    """Gauges from health, canary, invariant, backup, job and alert reports."""
    registry = registry or Registry()
    health = reports.get('health')
    if health:
        for check, result in health['checks'].items():
            registry.set('fichaje_probe_up', {'check': check}, {'UP': 1.0, 'DEGRADED': 0.5}.get(result['status'], 0.0))
            if 'latency_ms' in result:
                registry.set('fichaje_probe_latency_ms', {'check': check}, result['latency_ms'])
        db = health['checks'].get('postgres', {}).get('saturation')
        if db:
            registry.set('fichaje_db_connections_used_ratio', {}, db['connections_ratio'])
            registry.set('fichaje_db_lock_waiting', {}, db['lock_waiting'])
            registry.set('fichaje_db_deadlocks_total', {}, db['deadlocks'])
    canary = reports.get('canary')
    if canary:
        for channel, result in canary['channels'].items():
            registry.set('fichaje_canary_success', {'channel': channel}, 1.0 if result['status'] == 'PASS' else 0.0)
    invariants = reports.get('invariants')
    if invariants:
        for row in invariants['summary']:
            registry.set('fichaje_invariant_findings', {'invariant': row['invariant'], 'severity': row['severity']}, row['findings'])
    backup = reports.get('backup')
    if backup:
        for kind, result in ((k, backup[k]) for k in sorted(enum('backup_kinds')) if isinstance(backup.get(k), dict)):
            registry.set('fichaje_backup_ok', {'kind': kind}, 1.0 if result['status'] == 'OK' else 0.0)
            if result.get('age_seconds') is not None:
                registry.set('fichaje_backup_age_seconds', {'kind': kind}, result['age_seconds'])
    for job, result in (reports.get('jobs') or {}).items():
        registry.set('fichaje_job_last_run_success', {'job': job}, 1.0 if result['outcome'] == 'success' else 0.0)
    for alert in reports.get('alerts_firing') or []:
        registry.set('fichaje_alerts_firing', {'alert': alert['alert'], 'severity': alert['severity']}, 1.0)
    return registry


def rates(events, component: str | None = None) -> dict:
    """Signals for metric-based alerts (error rate, conflicts, regressions, p95)."""
    selected = [e for e in events if component is None or e['component'] == component]
    by_component: dict[str, dict] = {}
    for event in selected:
        stats = by_component.setdefault(event['component'], {'total': 0, 'errors': 0, 'clock': 0, 'version_conflicts': 0,
                                                             'clock_regressions': 0, 'retries': 0, 'kiosk_auth_rejections': 0,
                                                             'kiosk_rate_limited': 0, 'durations': []})
        stats['total'] += 1
        if event['outcome'] in ('failure', 'timeout', 'unknown'):
            stats['errors'] += 1
        if event['operation'].startswith(('clock.', 'kiosk.clock.')):
            stats['clock'] += 1
            if event.get('error_class') == 'VERSION_CONFLICT':
                stats['version_conflicts'] += 1
        if event.get('error_class') == 'CLOCK_REGRESSION':
            stats['clock_regressions'] += 1
        # H7: PIN rejections are "rejected", not failures; a burst of them is a security signal.
        if event['operation'] == 'kiosk.authenticate' and event.get('error_class') in ('AUTH_FAILED', 'RATE_LIMITED'):
            stats['kiosk_auth_rejections'] += 1
            if event['error_class'] == 'RATE_LIMITED':
                stats['kiosk_rate_limited'] += 1
        if event.get('attempt', 1) > 1:
            stats['retries'] += 1
        if 'duration_ms' in event:
            stats['durations'].append(event['duration_ms'])
    result = {}
    for name, stats in by_component.items():
        durations = sorted(stats.pop('durations'))
        stats['p95_ms'] = durations[min(len(durations) - 1, math.ceil(0.95 * len(durations)) - 1)] if durations else 0.0
        result[name] = stats
    return result


def read_events(paths) -> list[dict]:
    events = []
    for path in paths:
        for line in Path(path).read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if line.startswith('{'):
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                if isinstance(event, dict) and {'component', 'operation', 'outcome'} <= set(event):
                    events.append(event)
    return events


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Render OPS-02 metrics (Prometheus text) from events and reports')
    parser.add_argument('--events', nargs='*', default=[])
    parser.add_argument('--reports', help='JSON file with health/canary/invariants/backup/jobs reports')
    args = parser.parse_args()
    registry = from_events(read_events(args.events))
    if args.reports:
        from_reports(json.loads(Path(args.reports).read_text(encoding='utf-8')), registry)
    sys.stdout.write(registry.render())

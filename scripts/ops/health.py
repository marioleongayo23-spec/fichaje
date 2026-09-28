"""OBS-03 health aggregation: application, API, Auth, PostgreSQL, kiosk gateway
and export-link signer, each UP / DEGRADED / DOWN.

Probes are side-effect free and need no data: the API probe expects PostgREST
to reach PostgreSQL and refuse an anonymous read (401 + 42501); PostgreSQL is
checked by a monitor login that can only EXECUTE private.ops_db_health(). The
report never includes URLs, hosts, keys, tenants or data.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import CONTRACT, LOG, HttpError, OpsError, Timer, classify_exception, http_json, http_raw, now_iso, release_info  # noqa: E402
from retry import Operation, RetryPolicy, execute, NotRetryable, RetryExhausted  # noqa: E402

THRESHOLDS = CONTRACT['thresholds']
CRITICAL = set(CONTRACT['critical_checks'])


@dataclass
class Targets:
    app_url: str | None = None
    api_url: str | None = None
    anon_key: str | None = None
    db_dsn: str | None = None
    kiosk_url: str | None = None
    export_link_url: str | None = None


def _get(url: str, headers: dict, timeout: float) -> tuple[int, object]:
    return http_json('GET', url, headers, None, timeout)


ASSET_TYPES = {'.js': ('text/javascript', 'application/javascript'), '.css': ('text/css',)}


def fetch_asset(url: str, timeout: float) -> bytes:
    """A static SPA host (vite preview, Cloudflare Pages) answers a missing file
    with index.html and 200: the type and the content are checked, not the status."""
    status, body, headers = http_raw('GET', url, {'Accept': '*/*'}, timeout)
    kind = headers.get('content-type', '').split(';')[0].strip().lower()
    expected = next((types for suffix, types in ASSET_TYPES.items() if url.endswith(suffix)), ())
    if status != 200 or not body or kind not in expected or body.lstrip()[:15].lower().startswith((b'<!doctype', b'<html')):
        raise OpsError('INVALID_RESPONSE', 'app')
    return body


def probe_app(url: str, timeout: float) -> dict:
    status, raw, _ = http_raw('GET', url.rstrip('/') + '/', {'Accept': 'text/html'}, timeout)
    html = raw.decode('utf-8', 'replace')
    assets = re.findall(r'(?:src|href)="(/assets/[^"]+\.(?:js|css))"', html)
    if status != 200 or 'id="root"' not in html or not any(a.endswith('.js') for a in assets):
        raise OpsError('INVALID_RESPONSE', 'app')
    for asset in assets:
        fetch_asset(url.rstrip('/') + asset, timeout)
    return {}


def probe_api(url: str, anon: str, timeout: float) -> dict:
    try:
        http_json('GET', url.rstrip('/') + '/rest/v1/organizations?select=id&limit=1', {'apikey': anon, 'Authorization': 'Bearer ' + anon}, None, timeout)
    except HttpError as error:
        if error.status == 401:
            return {}   # expected: anonymous read reached PostgreSQL and was refused
        raise
    raise OpsError('INVALID_RESPONSE', 'api')  # an anonymous read must never succeed


def probe_auth(url: str, anon: str, timeout: float) -> dict:
    status, body = _get(url.rstrip('/') + '/auth/v1/health', {'apikey': anon}, timeout)
    if status != 200 or not isinstance(body, dict):
        raise OpsError('INVALID_RESPONSE', 'auth')
    return {}


def probe_postgres(dsn: str, timeout: float) -> dict:
    import psycopg
    try:
        with psycopg.connect(dsn, connect_timeout=max(1, int(timeout)), application_name='ops-health') as connection:
            connection.execute("set statement_timeout = %s" % int(timeout * 1000))
            health = connection.execute('select private.ops_db_health()').fetchone()[0]
    except psycopg.Error as error:
        raise OpsError('DB_UNAVAILABLE' if classify_exception(error) in ('DB_UNAVAILABLE', 'INTERNAL') else classify_exception(error), 'postgres') from None
    ratio = health['connections'] / max(1, health['max_connections'])
    return {'saturation': {'connections_ratio': round(ratio, 4), 'lock_waiting': int(health['lock_waiting']), 'deadlocks': int(health['deadlocks'])}}


def probe_gateway(url: str, timeout: float) -> dict:
    try:
        status, body = _get(url.rstrip('/') + '/health/ready', {}, timeout)
    except HttpError as error:
        if error.status == 503:
            raise OpsError('DEGRADED', 'gateway') from None
        raise
    if not isinstance(body, dict) or body.get('status') not in ('UP', 'DEGRADED'):
        raise OpsError('INVALID_RESPONSE', 'gateway')
    return {'dependency': body['status']}


def _run(check: str, probe, timeout: float) -> dict:
    timer = Timer()
    op = Operation('health', f'probe.{check}', idempotent=True, mutation=False)
    try:
        extra = execute(op, lambda _payload, _n: probe(), RetryPolicy(max_attempts=2, base_delay_ms=100, max_delay_ms=100))
    except (NotRetryable, RetryExhausted, OpsError) as error:
        cls = getattr(error, 'last_class', None) or error.error_class
        if cls == 'DEGRADED':
            cls = 'UPSTREAM_5XX'
        LOG.emit('health', f'probe.{check}', 'failure', error_class=cls, duration_ms=timer.ms, state='DOWN', check=check)
        return {'status': 'DOWN', 'latency_ms': timer.ms, 'error_class': cls}
    latency = timer.ms
    status = 'DEGRADED' if latency > THRESHOLDS['latency_degraded_ms'] or extra.get('dependency') == 'DEGRADED' else 'UP'
    saturation = extra.get('saturation')
    if saturation and (saturation['connections_ratio'] >= THRESHOLDS['db_connections_warning_ratio']
                       or saturation['lock_waiting'] >= THRESHOLDS['db_lock_waiting_warning']):
        status = 'DEGRADED'
    LOG.emit('health', f'probe.{check}', 'success' if status == 'UP' else 'degraded', duration_ms=latency, state=status, check=check,
             error_class='NONE' if status == 'UP' else 'DEGRADED')
    result = {'status': status, 'latency_ms': latency, 'error_class': 'NONE' if status == 'UP' else 'DEGRADED'}
    if saturation:
        result['saturation'] = saturation
    return result


def run(targets: Targets, timeout_ms: int | None = None) -> dict:
    timeout = (timeout_ms or THRESHOLDS['probe_timeout_ms']) / 1000
    timer = Timer()
    probes = {
        'app': (targets.app_url, lambda: probe_app(targets.app_url, timeout)),
        'api': (targets.api_url and targets.anon_key, lambda: probe_api(targets.api_url, targets.anon_key, timeout)),
        'auth': (targets.api_url and targets.anon_key, lambda: probe_auth(targets.api_url, targets.anon_key, timeout)),
        'postgres': (targets.db_dsn, lambda: probe_postgres(targets.db_dsn, timeout)),
        'kiosk_gateway': (targets.kiosk_url, lambda: probe_gateway(targets.kiosk_url, timeout)),
        'export_link': (targets.export_link_url, lambda: probe_gateway(targets.export_link_url, timeout)),
    }
    checks = {name: _run(name, probe, timeout) for name, (configured, probe) in probes.items() if configured}
    down = [n for n, r in checks.items() if r['status'] == 'DOWN']
    status = 'DOWN' if any(n in CRITICAL for n in down) else 'DEGRADED' if down or any(r['status'] == 'DEGRADED' for r in checks.values()) else 'UP'
    release, commit = release_info()
    LOG.emit('health', 'health.aggregate', {'UP': 'success', 'DEGRADED': 'degraded'}.get(status, 'failure'), state=status,
             duration_ms=timer.ms, count=len(checks), error_class='NONE' if status == 'UP' else 'DEGRADED' if status == 'DEGRADED' else 'INTERNAL')
    return {'status': status, 'checks': checks, 'generated_at': now_iso(), 'release': release, 'commit': commit}


def targets_from_args(args) -> Targets:
    return Targets(app_url=args.app_url, api_url=args.api_url, anon_key=os.environ.get(args.anon_key_env) if args.anon_key_env else None,
                   db_dsn=os.environ.get(args.db_dsn_env) if args.db_dsn_env else None,
                   kiosk_url=args.kiosk_url, export_link_url=args.export_link_url)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='OPS-02 health checks (credentials only via environment variable names)')
    parser.add_argument('--app-url')
    parser.add_argument('--api-url')
    parser.add_argument('--anon-key-env', default='SUPABASE_ANON_KEY')
    parser.add_argument('--db-dsn-env', default='OPS_MONITOR_DSN')
    parser.add_argument('--kiosk-url')
    parser.add_argument('--export-link-url')
    parser.add_argument('--timeout-ms', type=int)
    parser.add_argument('--out')
    args = parser.parse_args()
    report = run(targets_from_args(args), args.timeout_ms)
    text = json.dumps(report, sort_keys=True, indent=2)
    if args.out:
        Path(args.out).write_text(text + '\n', encoding='utf-8')
    print(text)
    sys.exit(0 if report['status'] != 'DOWN' else 2)

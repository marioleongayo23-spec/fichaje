"""H7 pilot load profile runner (synthetic tenants only).

Pilot objective (docs/ARCHITECTURE.md): 2 companies × up to 100 employees, 20
concurrent requests, p95 < 1 s. The runner is target-agnostic: it receives the
public API URL, the edge URL and a state of SYNTHETIC tenants (created by the
local suite, or by the operator in staging) and measures, with a fixed pool of
concurrent workers:
  - web fichajes CLOCK_IN → BREAK_START → BREAK_END → CLOCK_OUT per employee
    (record_time_event) and the state query after each step;
  - idempotent replays of confirmed requests (same request_id → same receipt);
  - kiosk authenticate + record through the edge (Argon2id + 300 ms floor);
  - a whole-company export (request + offline worker + signed link);
  - health and the synthetic canary running at the same time;
  - PostgreSQL connections, lock waits and deadlocks (monitor login, aggregates).
Only stable error classes and timings are reported; never payloads, tokens,
identifiers or personal data. Results are measurements, not an SLA.
"""
from __future__ import annotations

import json
import statistics
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import HttpError, OpsError, classify_exception, http_json  # noqa: E402

CYCLE = ('CLOCK_IN', 'BREAK_START', 'BREAK_END', 'CLOCK_OUT')


@dataclass
class Recorder:
    samples: dict = field(default_factory=dict)
    errors: dict = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def timed(self, operation: str, call):
        started = time.perf_counter()
        ok = False
        try:
            value = call()
            ok = True
            return value
        except (HttpError, OpsError, OSError, ValueError) as error:
            ok = False
            cls = getattr(error, 'error_class', None) or classify_exception(error, sent=True)
            with self.lock:
                self.errors.setdefault(operation, {}).setdefault(cls, 0)
                self.errors[operation][cls] += 1
            raise
        finally:
            elapsed = (time.perf_counter() - started) * 1000
            with self.lock:
                self.samples.setdefault(operation, []).append((elapsed, ok))

    def summary(self) -> dict:
        out = {}
        for operation, values in sorted(self.samples.items()):
            latencies = sorted(v for v, _ in values)
            q = statistics.quantiles(latencies, n=100, method='inclusive') if len(latencies) >= 2 else latencies * 99
            out[operation] = {'count': len(values), 'errors': sum(1 for _, ok in values if not ok), 'p50_ms': round(q[49], 1),
                              'p95_ms': round(q[94], 1), 'p99_ms': round(q[98], 1), 'max_ms': round(latencies[-1], 1),
                              'error_classes': self.errors.get(operation, {})}
        return out


class Api:
    def __init__(self, url: str, anon: str, timeout: float = 30):
        self.url, self.anon, self.timeout = url.rstrip('/'), anon, timeout

    def rpc(self, name: str, token: str, args: dict):
        return http_json('POST', f'{self.url}/rest/v1/rpc/{name}', {'apikey': self.anon, 'Authorization': 'Bearer ' + token},
                         json.dumps(args).encode(), self.timeout)[1]


class DbSampler(threading.Thread):
    """Aggregated PostgreSQL pressure through the least-privileged monitor login."""

    def __init__(self, monitor_dsn: str, interval: float = 0.5):
        super().__init__(daemon=True)
        self.dsn, self.interval, self.stop_event, self.rows = monitor_dsn, interval, threading.Event(), []

    def run(self):
        import psycopg
        with psycopg.connect(self.dsn, autocommit=True) as connection:
            while not self.stop_event.is_set():
                health = connection.execute('select private.ops_db_health()').fetchone()[0]
                self.rows.append(health)
                self.stop_event.wait(self.interval)

    def summary(self) -> dict:
        if not self.rows:
            return {}
        return {'samples': len(self.rows), 'max_connections_used': max(r['connections'] for r in self.rows),
                'max_connections': self.rows[-1]['max_connections'], 'max_lock_waiting': max(int(r['lock_waiting']) for r in self.rows),
                'deadlocks_delta': int(self.rows[-1]['deadlocks']) - int(self.rows[0]['deadlocks'])}


def web_employee(api: Api, recorder: Recorder, tenant: str, worker: dict, replays: list, replay_every: int, index: int) -> None:
    version = worker.get('version', 0)
    for action in CYCLE:
        args = {'p_organization_id': tenant, 'p_request_id': str(uuid.uuid4()), 'p_employee_id': worker['employee'],
                'p_action': action, 'p_expected_version': version}
        receipt = recorder.timed(f'clock.{action}', lambda: api.rpc('record_time_event', worker['token'], args))
        version += 1
        state = recorder.timed('rpc.get_employee_state', lambda: api.rpc('get_employee_state', worker['token'],
                               {'p_organization_id': tenant, 'p_employee_id': worker['employee']}))
        if state['version'] != version:
            raise OpsError('ASSERTION', 'state')
        if index % replay_every == 0:
            again = recorder.timed('clock.replay', lambda: api.rpc('record_time_event', worker['token'], args))
            replays.append(again == receipt)
    worker['version'] = version


def kiosk_employee(edge: str, recorder: Recorder, tenant: str, device: dict, person: dict,
                   pace: tuple[float, float] | None = None) -> None:
    """One kiosk visit per action. pace=(typing_s, choosing_s) adds the human time a person
    needs at a physical kiosk (code + PIN before identifying, choosing the action before
    recording); without it the kiosk is driven back-to-back (saturation)."""
    for action in CYCLE:
        if pace:
            time.sleep(pace[0])
        body = {'organization_id': tenant, 'device_id': device['id'], 'code': person['code'], 'pin': person['pin']}
        offer = recorder.timed('kiosk.authenticate', lambda: http_json('POST', edge + '/gateway/kiosk/authenticate',
                               {'Authorization': 'Bearer ' + device['token']}, json.dumps(body).encode(), 30)[1])
        challenge = next(c for c in offer['challenges'] if c['action'] == action)
        if pace:
            time.sleep(pace[1])
        record = {'organization_id': tenant, 'device_id': device['id'], 'request_id': challenge['request_id'], 'challenge': challenge['challenge'],
                  'action': action, 'expected_version': offer['version']}
        recorder.timed(f'kiosk.clock.{action}', lambda: http_json('POST', edge + '/gateway/kiosk/record',
                       {'Authorization': 'Bearer ' + device['token']}, json.dumps(record).encode(), 30)[1])


def run_pool(concurrency: int, jobs: list) -> list:
    failures = []
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = [pool.submit(job) for job in jobs]
        for future in futures:
            try:
                future.result()
            except Exception as error:  # noqa: BLE001 - counted by class, never printed with values
                failures.append(type(error).__name__)
    return failures


def background(stop: threading.Event, probe, interval: float, results: list) -> threading.Thread:
    def loop():
        while not stop.is_set():
            try:
                results.append(probe())
            except Exception as error:  # noqa: BLE001
                results.append({'status': 'ERROR', 'error': type(error).__name__})
            stop.wait(interval)
    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return thread

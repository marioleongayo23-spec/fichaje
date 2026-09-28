"""OPS-02 common operational layer (OBS-01).

One JSON line per operation, built only from the enumerations and patterns of
ops/contract.json. Unknown keys are dropped, invalid values are dropped, and a
programming error (unknown component/operation) fails fast. Exceptions are
mapped to stable error classes: their text (SQL, parameters, URLs, bodies) is
never serialized.
"""
from __future__ import annotations

import json
import math
import os
import re
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = ROOT / 'ops' / 'contract.json'
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding='utf-8'))

UUID_RE = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
CODE_RE = re.compile(r'^[A-Za-z0-9_.:-]{1,64}$')
RELEASE_RE = re.compile(r'^[0-9A-Za-z.+_-]{1,64}$')
COMMIT_RE = re.compile(r'^([0-9a-f]{7,40}|unknown)$')
ERROR_CLASSES = frozenset(CONTRACT['error_classes'])
ALERT_NAMES = frozenset(CONTRACT['alerts'])


def enum(name: str) -> frozenset[str]:
    if name == 'alert_names':
        return ALERT_NAMES
    return frozenset(CONTRACT[name])


def release_info() -> tuple[str, str]:
    """Release/commit for correlation. Public metadata, never a secret."""
    release = os.environ.get('FICHAJE_RELEASE', 'dev')
    commit = os.environ.get('FICHAJE_COMMIT') or os.environ.get('GITHUB_SHA') or 'unknown'
    return (release if RELEASE_RE.match(release) else 'invalid',
            commit.lower() if COMMIT_RE.match(commit.lower()) else 'unknown')


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def _valid(kind: str, value):
    if kind == 'uuid':
        return value.lower() if isinstance(value, str) and UUID_RE.match(value.lower()) else None
    if kind == 'code':
        return value if isinstance(value, str) and CODE_RE.match(value) else None
    if kind == 'release':
        return value if isinstance(value, str) and RELEASE_RE.match(value) else None
    if kind == 'commit':
        return value if isinstance(value, str) and COMMIT_RE.match(value) else None
    if kind == 'number':
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            return None
        return round(float(value), 3)
    if kind == 'integer':
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None
    if kind == 'http_status':
        return value if isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599 else None
    if kind == 'timestamp':
        return value if isinstance(value, str) and re.match(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$', value) else None
    return value if isinstance(value, str) and value in enum(kind) else None


def build_event(component: str, operation: str, outcome: str, **fields) -> dict:
    """Validated, allowlisted operational event. Raises on programming errors."""
    if component not in enum('components') or operation not in enum('operations') or outcome not in enum('outcomes'):
        raise ValueError('OPS_EVENT_CONTRACT')
    release, commit = release_info()
    event = {'ts': now_iso(), 'level': fields.pop('level', 'error' if outcome in ('failure', 'unknown') else 'info'),
             'release': release, 'commit': commit, 'component': component, 'operation': operation, 'outcome': outcome}
    spec = CONTRACT['event_fields']
    for key, value in fields.items():
        if key in spec and key not in event and value is not None:
            checked = _valid(spec[key], value)
            if checked is not None:
                event[key] = checked
    if _valid('levels', event['level']) is None:
        event['level'] = 'info'
    event.setdefault('error_class', 'NONE' if outcome == 'success' else 'INTERNAL')
    return event


class EventLog:
    """Thread-safe JSON-lines writer (stdout by default, or OPS_EVENT_LOG)."""

    def __init__(self, path: str | None = None, stream=None):
        self.path = path if path is not None else os.environ.get('OPS_EVENT_LOG')
        self.stream = stream
        self.lock = threading.Lock()
        self.events: list[dict] = []

    def emit(self, component: str, operation: str, outcome: str, **fields) -> dict:
        event = build_event(component, operation, outcome, **fields)
        line = json.dumps(event, sort_keys=True, separators=(',', ':'))
        with self.lock:
            self.events.append(event)
            if self.path:
                with open(self.path, 'a', encoding='utf-8') as handle:
                    handle.write(line + '\n')
            else:
                print(line, file=self.stream or sys.stdout, flush=True)
        return event


LOG = EventLog()


def emit(component: str, operation: str, outcome: str, **fields) -> dict:
    return LOG.emit(component, operation, outcome, **fields)


class Timer:
    def __init__(self):
        self.started = time.monotonic()

    @property
    def ms(self) -> float:
        return round((time.monotonic() - self.started) * 1000, 3)


# --- Stable error classification -------------------------------------------------
SQLSTATE_CLASSES = {
    '40001': 'VERSION_CONFLICT', 'PT409': 'VERSION_CONFLICT', '42501': 'FORBIDDEN', '22023': 'INVALID_INPUT',
    '55P03': 'RETRYABLE_TIMEOUT', '57014': 'RETRYABLE_TIMEOUT', '40P01': 'RETRYABLE_TIMEOUT',
    '08000': 'DB_UNAVAILABLE', '08001': 'DB_UNAVAILABLE', '08003': 'DB_UNAVAILABLE', '08004': 'DB_UNAVAILABLE',
    '08006': 'DB_UNAVAILABLE', '57P01': 'DB_UNAVAILABLE', '57P02': 'DB_UNAVAILABLE', '57P03': 'DB_UNAVAILABLE',
    '53300': 'DB_UNAVAILABLE',
}


def known_code(value) -> str | None:
    """A backend message is trusted only when it IS one of the stable codes."""
    return value if isinstance(value, str) and value in ERROR_CLASSES and value != 'NONE' else None


def classify_http(status: int, body=None) -> str:
    payload = body if isinstance(body, dict) else {}
    # A stable code is authoritative whatever the status (as in src/lib/errors.ts):
    # PostgREST answers SQLSTATE 40001 VERSION_CONFLICT with HTTP 500, and a
    # conflict must never be counted or retried as an upstream failure.
    code = known_code(payload.get('message')) or known_code(payload.get('error'))
    if code and code != 'INTERNAL':
        return code
    if payload.get('code') in ('55P03', '57014'):
        return 'RETRYABLE_TIMEOUT'
    if status in (401,) or payload.get('code') in ('PGRST301', 'PGRST303'):
        return 'UNAUTHENTICATED'
    if status == 403:
        return 'FORBIDDEN'
    if status == 409:
        return code or 'VERSION_CONFLICT'
    if status in (400, 404, 422):
        return 'INVALID_INPUT'
    if status in (502, 503, 504) or status >= 500:
        return 'UPSTREAM_5XX'
    return 'INTERNAL'


def classify_exception(error: BaseException, sent: bool = False) -> str:
    """sent=True: the request may have reached the server (unknown outcome)."""
    if isinstance(error, OpsError):
        return error.error_class
    sqlstate = getattr(error, 'sqlstate', None)
    if isinstance(sqlstate, str):
        diag = getattr(error, 'diag', None)
        message = getattr(diag, 'message_primary', None)
        return known_code(message) or SQLSTATE_CLASSES.get(sqlstate, 'INTERNAL')
    module = type(error).__module__
    if module.startswith('psycopg'):
        return 'DB_UNAVAILABLE'
    if isinstance(error, HttpError):
        return error.error_class
    if isinstance(error, (TimeoutError, socket.timeout)):
        return 'UNKNOWN_OUTCOME' if sent else 'TIMEOUT'
    if isinstance(error, urllib.error.URLError) and isinstance(error.reason, (TimeoutError, socket.timeout)):
        return 'UNKNOWN_OUTCOME' if sent else 'TIMEOUT'
    if isinstance(error, (ConnectionRefusedError,)):
        return 'NETWORK'
    if isinstance(error, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
        return 'UNKNOWN_OUTCOME' if sent else 'NETWORK'
    if isinstance(error, urllib.error.URLError) or isinstance(error, OSError):
        return 'NETWORK'
    if isinstance(error, (ValueError, json.JSONDecodeError)):
        return 'INVALID_RESPONSE'
    return 'INTERNAL'


class HttpError(Exception):
    """HTTP failure carrying only status and stable class, never the body."""

    def __init__(self, status: int, error_class: str):
        super().__init__(f'HTTP {status} {error_class}')
        self.status = status
        self.error_class = error_class


class OpsError(Exception):
    """Operational failure with a stable class and no sensitive text."""

    def __init__(self, error_class: str, stage: str = 'unknown'):
        super().__init__(error_class)
        self.error_class = error_class if error_class in ERROR_CLASSES else 'INTERNAL'
        self.stage = stage


def http_json(method: str, url: str, headers: dict | None = None, body: bytes | None = None,
              timeout: float = 10.0) -> tuple[int, object]:
    """Minimal HTTP JSON client. Raises HttpError (status + class) or OSError."""
    request = urllib.request.Request(url, data=body, method=method, headers=dict(headers or {}))
    if body is not None:
        request.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as error:
        raw = error.read()
        try:
            payload = json.loads(raw) if raw else None
        except ValueError:
            payload = None
        raise HttpError(error.code, classify_http(error.code, payload)) from None
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        raise OpsError('INVALID_RESPONSE', 'decode') from None


def http_raw(method: str, url: str, headers: dict | None = None, timeout: float = 10.0) -> tuple[int, bytes, dict]:
    """Raw body; response header names are lower-cased (proxies differ in case)."""
    request = urllib.request.Request(url, method=method, headers=dict(headers or {}))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read(), {k.lower(): v for k, v in response.headers.items()}
    except urllib.error.HTTPError as error:
        error.read()
        raise HttpError(error.code, classify_http(error.code)) from None


def loopback(url_or_host: str) -> bool:
    """Fault injection, provisioning and privileged fixtures only ever target loopback."""
    host = url_or_host
    if '://' in host:
        host = urllib.parse.urlparse(host).hostname or ''
    return host in ('127.0.0.1', 'localhost', '::1')


def write_private(path: Path, data: str) -> None:
    """State files may hold synthetic credentials: owner-only permissions."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(data)

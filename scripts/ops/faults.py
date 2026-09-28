"""OPS-02 failure-injection harness for CI and local drills ONLY.

Every fault is real for the system under test: a TCP/HTTP hop that refuses,
delays, answers 5xx or loses an ACK after forwarding; a candidate release
artifact with a real defect; a stopped/paused local container; privileged
synthetic drift in an ephemeral database. Detection must then happen through
the unchanged operational code (health, canary, invariants, alerts). Nothing
here patches an assertion or a status flag.

Refuses to run unless OPS_FAULT_INJECTION=1 and every target is loopback.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import LOG, OpsError, loopback  # noqa: E402

CONTAINER = re.compile(r'^supabase_[a-z]+_fichaje-h1$')


def require_enabled(*targets: str) -> None:
    if os.environ.get('OPS_FAULT_INJECTION') != '1' or not all(loopback(t) for t in targets):
        raise OpsError('CONFIG', 'faults')


class TcpProxy:
    """Loopback TCP hop: pass | refuse | delay | blackhole."""

    def __init__(self, target_host: str, target_port: int):
        require_enabled(target_host)
        self.target = (target_host, target_port)
        self.mode, self.delay = 'pass', 0.0
        self.server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.server.bind(('127.0.0.1', 0))
        self.server.listen(64)
        self.port = self.server.getsockname()[1]
        self.open: list[socket.socket] = []
        self.running = True
        threading.Thread(target=self._accept, daemon=True).start()

    def set(self, mode: str, delay_ms: float = 0) -> None:
        if mode not in ('pass', 'refuse', 'delay', 'blackhole'):
            raise ValueError('UNKNOWN_FAULT')
        self.mode, self.delay = mode, delay_ms / 1000
        if mode != 'pass':
            for sock in list(self.open):   # established connections fail too
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        LOG.emit('fault-injection', 'fault.inject' if mode != 'pass' else 'fault.clear', 'success')

    def _accept(self) -> None:
        while self.running:
            try:
                client, _ = self.server.accept()
            except OSError:
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client: socket.socket) -> None:
        mode = self.mode
        if mode == 'refuse':
            client.close()
            return
        if mode == 'blackhole':
            self.open.append(client)
            return
        if mode == 'delay':
            time.sleep(self.delay)
        try:
            upstream = socket.create_connection(self.target, timeout=10)
        except OSError:
            client.close()
            return
        upstream.settimeout(None)
        self.open.extend([client, upstream])

        def pump(src, dst):
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                for sock in (src, dst):
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
        threading.Thread(target=pump, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pump, args=(upstream, client), daemon=True).start()

    def close(self) -> None:
        self.running = False
        self.server.close()
        for sock in self.open:
            try:
                sock.close()
            except OSError:
                pass


class QuietServer(ThreadingHTTPServer):
    """A caller that gave up (timeout, lost ACK) breaks the pipe: expected here, not a trace to print."""
    daemon_threads = True

    def handle_error(self, request, client_address):
        pass


class HttpFaultProxy:
    """Loopback HTTP hop with per-path rules: pass | status:<code> | delay:<ms> |
    drop_after_forward (lost ACK: the upstream commits, the caller never hears) | refuse.
    Records SHA-256 of forwarded bodies so exact retries can be proven."""

    def __init__(self, target_url: str):
        require_enabled(target_url)
        self.target = target_url.rstrip('/')
        self.rules: list[tuple[str, str]] = []
        self.forwarded: list[tuple[str, str, str]] = []
        self.seen = 0
        self.lock = threading.Lock()
        proxy = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def log_message(self, *_):
                pass

            def _handle(self):
                length = int(self.headers.get('Content-Length') or 0)
                body = self.rfile.read(length) if length else None
                with proxy.lock:
                    proxy.seen += 1
                    rule = next((mode for prefix, mode in proxy.rules if self.path.startswith(prefix)), 'pass')
                    if rule == 'drop_after_forward_once':   # one lost ACK, then healthy again
                        proxy.rules = [(p, m) for p, m in proxy.rules if m != 'drop_after_forward_once']
                        rule = 'drop_after_forward'
                if rule == 'refuse':
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                if rule.startswith('status:'):
                    payload = json.dumps({'message': 'INJECTED_UPSTREAM_FAILURE'}).encode()
                    self.send_response(int(rule.split(':')[1]))
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                if rule.startswith('delay:'):
                    time.sleep(int(rule.split(':')[1]) / 1000)
                headers = {k: v for k, v in self.headers.items() if k.lower() not in ('host', 'content-length', 'connection', 'accept-encoding')}
                request = urllib.request.Request(proxy.target + self.path, data=body, method=self.command, headers=headers)
                with proxy.lock:
                    proxy.forwarded.append((self.command, self.path.split('?')[0], hashlib.sha256(body or b'').hexdigest()))
                try:
                    with urllib.request.urlopen(request, timeout=30) as response:
                        status, data, rheaders = response.status, response.read(), response.headers
                except urllib.error.HTTPError as error:
                    status, data, rheaders = error.code, error.read(), error.headers
                if rule == 'drop_after_forward':
                    self.close_connection = True
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                self.send_response(status)
                for key in ('Content-Type', 'Cache-Control', 'Content-Range'):
                    if rheaders.get(key):
                        self.send_header(key, rheaders[key])
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = do_PATCH = do_DELETE = do_HEAD = _handle

        self.server = QuietServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def set(self, prefix: str, mode: str) -> None:
        self.rules = [(p, m) for p, m in self.rules if p != prefix]
        if mode != 'pass':
            self.rules.insert(0, (prefix, mode))
        LOG.emit('fault-injection', 'fault.inject' if mode != 'pass' else 'fault.clear', 'success')

    def clear(self) -> None:
        self.rules = []
        LOG.emit('fault-injection', 'fault.clear', 'success')

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


def break_release(release_dir: Path, kind: str) -> None:
    """Injects a real defect into a built candidate artifact (not into the gate)."""
    require_enabled('127.0.0.1')
    release_dir = Path(release_dir)
    if kind == 'gateway-record-broken':
        path = release_dir / 'functions' / 'kiosk' / 'index.ts'
        text = path.read_text(encoding='utf-8')
        if text.count('private.kiosk_record(') != 1:
            raise OpsError('CONFIG', 'faults')
        path.write_text(text.replace('private.kiosk_record(', 'private.kiosk_record_unavailable('), encoding='utf-8')
    elif kind == 'gateway-crash':
        path = release_dir / 'functions' / 'kiosk' / 'index.ts'
        path.write_text("throw new Error('INJECTED_RELEASE_DEFECT');\n" + path.read_text(encoding='utf-8'), encoding='utf-8')
    elif kind == 'edge-signature-broken':
        # H7: an edge release that signs the wrong route; every function refuses it.
        path = release_dir / 'pages' / 'edge' / 'gateway.ts'
        text = path.read_text(encoding='utf-8')
        needle = 'route.method, route.component, route.route, body)'
        if text.count(needle) != 1:
            raise OpsError('CONFIG', 'faults')
        path.write_text(text.replace(needle, "route.method, route.component, 'broken', body)"), encoding='utf-8')
    elif kind == 'app-missing-asset':
        entries = list((release_dir / 'dist' / 'assets').glob('index-*.js'))
        if len(entries) != 1:
            raise OpsError('CONFIG', 'faults')
        entries[0].unlink()
    else:
        raise ValueError('UNKNOWN_FAULT')
    LOG.emit('fault-injection', 'fault.inject', 'success')


def container(action: str, name: str) -> None:
    """Local Supabase containers only (docker stop/start/pause/unpause)."""
    require_enabled('127.0.0.1')
    if action not in ('stop', 'start', 'pause', 'unpause') or not CONTAINER.match(name) or shutil.which('docker') is None:
        raise OpsError('CONFIG', 'faults')
    subprocess.run(['docker', action, name], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    LOG.emit('fault-injection', 'fault.inject' if action in ('stop', 'pause') else 'fault.clear', 'success')


# --- Synthetic drift in an EPHEMERAL database (privileged fixture writes) ----------
def _sql(dsn: str, statements: list[tuple[str, tuple]]) -> None:
    import psycopg
    host = re.search(r'@([^:/]+)', dsn)
    require_enabled(host.group(1) if host else '')
    with psycopg.connect(dsn) as connection:
        for statement, params in statements:
            connection.execute(statement, params)
    LOG.emit('fault-injection', 'fault.inject', 'success')


def projection_drift(dsn: str, org: str, employee: str) -> None:
    """Corrupt only the derived projection (repairable drift)."""
    _sql(dsn, [("""update private.employee_state set state='WORKING',version=greatest(version-1,0),
      open_session_id=(select session_id from public.time_events where organization_id=%s and employee_id=%s order by sequence limit 1)
      where organization_id=%s and employee_id=%s""", (org, employee, org, employee))])


def clock_regression(dsn: str, org: str, employee: str) -> None:
    """Recorded high-water mark ahead of the server clock (as TIME-05 in H2): the next
    fichaje must fail with CLOCK_REGRESSION and write nothing."""
    _sql(dsn, [("update private.employee_state set last_event_at=clock_timestamp()+interval '1 day' where organization_id=%s and employee_id=%s",
                (org, employee))])


def tamper_original(dsn: str, org: str, employee: str, sequence: int) -> None:
    """Simulates a superuser edit of an original bypassing the append-only guard."""
    _sql(dsn, [('alter table public.time_events disable trigger immutable', ()),
               ("update public.time_events set request_id=gen_random_uuid() where organization_id=%s and employee_id=%s and sequence=%s", (org, employee, sequence)),
               ('alter table public.time_events enable trigger immutable', ())])


def delete_original(dsn: str, org: str, employee: str, sequence: int) -> None:
    """Simulates deleting an original outside the purge process (audit and receipt stay)."""
    _sql(dsn, [('alter table public.time_events disable trigger immutable', ()),
               ("delete from public.time_events where organization_id=%s and employee_id=%s and sequence=%s", (org, employee, sequence)),
               ('alter table public.time_events enable trigger immutable', ())])


def cross_tenant_audit(dsn: str, org: str, actor: str, foreign_event: str) -> None:
    """An audit row of tenant A (by one of its users) pointing to an original of tenant B."""
    _sql(dsn, [("""insert into public.audit_log(organization_id,actor_kind,actor_id,action,entity_type,entity_id,request_id)
      values(%s,'USER',%s,'record_time_event','time_events',%s,gen_random_uuid())""", (org, actor, foreign_event))])


def disable_guard(dsn: str, table: str, trigger: str) -> None:
    if not re.match(r'^(public|private)\.[a-z_]+$', table) or not re.match(r'^[a-z_]+$', trigger):
        raise ValueError('INVALID_GUARD')
    _sql(dsn, [(f'alter table {table} disable trigger {trigger}', ())])


def enable_guard(dsn: str, table: str, trigger: str) -> None:
    if not re.match(r'^(public|private)\.[a-z_]+$', table) or not re.match(r'^[a-z_]+$', trigger):
        raise ValueError('INVALID_GUARD')
    _sql(dsn, [(f'alter table {table} enable trigger {trigger}', ())])

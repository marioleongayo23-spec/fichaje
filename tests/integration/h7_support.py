"""H7 real harness helpers (loopback only, synthetic data only).

Local ephemeral Supabase (Auth, PostgREST, Storage, PostgreSQL), the real kiosk
gateway and export-link signer (Deno) with an ingress secret, and the real
Cloudflare Pages runtime (workerd, through the pinned wrangler of edge/) serving
the built app and the /gateway Pages Function in front of them. Nothing here
reaches a remote platform, uses real data or uploads artefacts. Secrets are
generated per run, kept in memory or 0600 files of a private temporary
directory, and registered as "known" values for the final leak scan.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'ops'))
sys.path.insert(0, str(ROOT / 'scripts'))
import psycopg  # noqa: E402
import opslib  # noqa: E402
import canary as canary_mod  # noqa: E402

OPERATOR = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
CONTAINER = 'supabase_db_fichaje-h1'
WRANGLER = ROOT / 'edge' / 'node_modules' / '.bin' / 'wrangler'
COMPATIBILITY_DATE = '2026-09-01'


def stack() -> dict:
    status = json.loads(subprocess.check_output(['supabase', 'status', '-o', 'json'], cwd=ROOT, stderr=subprocess.DEVNULL))
    assert status['API_URL'] in ('http://127.0.0.1:54321', 'http://localhost:54321'), 'Local stack only'
    return {'url': status['API_URL'], 'anon': status['ANON_KEY'], 'service': status['SERVICE_ROLE_KEY'],
            'publishable': status['PUBLISHABLE_KEY']}


class Suite:
    """Counts real checks; remembers synthetic sensitive values for leak scans."""

    def __init__(self, name: str):
        self.name = name
        self.count = 0
        self.known: list[str] = []
        self.scratch = Path(tempfile.mkdtemp(prefix=f'{name}-'))
        os.chmod(self.scratch, 0o700)

    def check(self, condition, label: str) -> None:
        assert condition, label
        self.count += 1
        print(f'ok {self.count} - {label}', flush=True)

    def remember(self, *values) -> None:
        self.known.extend(v for v in values if isinstance(v, str) and len(v) >= 6)


def uid() -> str:
    return str(uuid.uuid4())


def secret_b64(size: int = 32) -> str:
    return base64.b64encode(secrets.token_bytes(size)).decode()


def rows(query: str, params=(), dsn: str = OPERATOR):
    with psycopg.connect(dsn) as connection:
        return connection.execute(query, params).fetchall()


def one(query: str, params=(), dsn: str = OPERATOR):
    return rows(query, params, dsn)[0][0]


def login(suite: Suite, name: str, role: str) -> str:
    password = secrets.token_hex(24)
    with psycopg.connect(OPERATOR, autocommit=True) as connection:
        connection.execute(psycopg.sql.SQL('drop role if exists {}').format(psycopg.sql.Identifier(name)))
        connection.execute(psycopg.sql.SQL('create role {} login inherit password {}').format(
            psycopg.sql.Identifier(name), psycopg.sql.Literal(password)))
        connection.execute(psycopg.sql.SQL('grant {} to {}').format(psycopg.sql.Identifier(role), psycopg.sql.Identifier(name)))
    suite.remember(password)
    return f'postgresql://{name}:{password}@127.0.0.1:54322/postgres'


def drop_logins(*names: str) -> None:
    with psycopg.connect(OPERATOR, autocommit=True) as connection:
        for name in names:
            connection.execute(psycopg.sql.SQL('drop role if exists {}').format(psycopg.sql.Identifier(name)))


def http(method: str, url: str, headers: dict | None = None, body: bytes | None = None, timeout: float = 20):
    """(status, lower-cased headers, body) without raising on HTTP errors."""
    request = urllib.request.Request(url, data=body, method=method, headers=dict(headers or {}))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def http_json(method: str, url: str, headers: dict | None = None, payload=None, timeout: float = 20):
    data = None if payload is None else json.dumps(payload).encode()
    merged = {**(headers or {}), **({'Content-Type': 'application/json'} if data is not None else {})}
    status, response_headers, raw = http(method, url, merged, data, timeout)
    try:
        return status, response_headers, json.loads(raw) if raw else None
    except ValueError:
        return status, response_headers, None


def wait_http(url: str, timeout_s: float = 90, ok=(200,)) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            if http('GET', url, timeout=3)[0] in ok:
                return True
        except OSError:
            pass
        time.sleep(0.25)
    return False


class Processes:
    """Owns child process groups (Deno functions, workerd) and stops them."""

    def __init__(self, logs: Path):
        self.logs = logs
        logs.mkdir(parents=True, exist_ok=True)
        self.children: list[subprocess.Popen] = []

    def spawn(self, name: str, command: list[str], env: dict, cwd: Path = ROOT) -> subprocess.Popen:
        log = open(self.logs / f'{name}.log', 'ab')
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=log, stderr=log, start_new_session=True)
        self.children.append(child)
        return child

    def stop(self, child: subprocess.Popen | None = None) -> None:
        targets = [child] if child else list(self.children)
        for item in targets:
            try:
                os.killpg(item.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        for item in targets:
            try:
                item.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(item.pid, signal.SIGKILL)
            if item in self.children:
                self.children.remove(item)


def build_dist(out: Path, url: str, publishable: str, release: str) -> Path:
    env = {**os.environ, 'VITE_SUPABASE_URL': url, 'VITE_SUPABASE_PUBLISHABLE_KEY': publishable, 'FICHAJE_RELEASE': release}
    subprocess.run(['npm', 'run', 'build', '--', '--outDir', str(out), '--emptyOutDir'], cwd=ROOT, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return out


def functions_env(stack_info: dict, gateway_dsn: str, pepper: str, network: str, ingress: str | None, release: str = 'h7-local') -> dict:
    env = {**os.environ, 'KIOSK_AUTH_URL': stack_info['url'], 'KIOSK_ANON_KEY': stack_info['anon'],
           'KIOSK_AUTH_PROVISION_KEY': stack_info['service'], 'KIOSK_DATABASE_URL': gateway_dsn, 'KIOSK_PEPPER': pepper,
           'KIOSK_NETWORK_SECRET': network, 'SUPABASE_URL': stack_info['url'], 'SUPABASE_ANON_KEY': stack_info['anon'],
           'SUPABASE_SERVICE_ROLE_KEY': stack_info['service'], 'SUPABASE_DB_URL': OPERATOR,
           'FICHAJE_RELEASE': release, 'FICHAJE_ENV': 'ci'}
    if ingress:
        env['FICHAJE_INGRESS_SECRET'] = ingress
    return env


def start_functions(processes: Processes, env: dict, kiosk_port: int, export_port: int, source: Path = ROOT / 'supabase' / 'functions',
                    tag: str = 'fn') -> None:
    processes.spawn(f'{tag}-kiosk', ['deno', 'run', '--allow-env', '--allow-net', '--config', str(source / 'kiosk' / 'deno.json'),
                                     str(source / 'kiosk' / 'index.ts')], {**env, 'KIOSK_PORT': str(kiosk_port)})
    processes.spawn(f'{tag}-export-link', ['deno', 'run', '--allow-env', '--allow-net', '--config', str(source / 'export-link' / 'deno.json'),\n                                      str(source / 'export-link' / 'index.ts')],
                    {**env, 'EXPORT_LINK_PORT': str(export_port)})
    for port in (kiosk_port, export_port):
        assert wait_http(f'http://127.0.0.1:{port}/health/live', 90, ok=(200, 403)), 'function did not start'


def start_edge(processes: Processes, workdir: Path, dist: Path, port: int, values: dict, pages_source: Path = ROOT, tag: str = 'edge') -> str:
    """wrangler pages dev (workerd) serving dist + functions/ with secrets in a 0600 .dev.vars (never argv)."""
    assert WRANGLER.exists(), 'run npm ci --prefix edge first'
    project = workdir / f'{tag}-project'
    if project.exists():
        shutil.rmtree(project)
    project.mkdir(parents=True)
    os.symlink(pages_source / 'functions', project / 'functions')
    variables = project / '.dev.vars'
    fd = os.open(variables, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        handle.write(''.join(f'{k}="{v}"\n' for k, v in values.items()))
    # No metrics and no download of Cloudflare's request.cf sample: the local runtime stays offline.
    env = {**os.environ, 'WRANGLER_SEND_METRICS': 'false', 'CLOUDFLARE_CF_FETCH_ENABLED': 'false', 'CI': '1', 'NO_COLOR': '1', 'WRANGLER_LOG': 'warn'}
    processes.spawn(tag, [str(WRANGLER), 'pages', 'dev', str(dist), '--ip', '127.0.0.1', '--port', str(port),
                          '--compatibility-date', COMPATIBILITY_DATE, '--log-level', 'warn'], env, cwd=project)
    url = f'http://127.0.0.1:{port}'
    assert wait_http(url + '/', 120), 'edge did not start'
    return url


class KioskAdmin:
    """Manager-side kiosk operations through a gateway base URL (the edge in H7)."""

    def __init__(self, gateway_url: str):
        from cryptography.hazmat.primitives.asymmetric import rsa
        self.gateway = canary_mod.Gateway(gateway_url)
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        numbers = self.key.public_key().public_numbers()
        b64 = lambda i: base64.urlsafe_b64encode(i.to_bytes((i.bit_length() + 7) // 8, 'big')).decode().rstrip('=')  # noqa: E731
        self.jwk = {'kty': 'RSA', 'n': b64(numbers.n), 'e': b64(numbers.e), 'alg': 'RSA-OAEP-256', 'ext': True}

    def open(self, delivery: str) -> str:
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import padding
        return self.key.decrypt(base64.b64decode(delivery), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
                                                                          algorithm=hashes.SHA256(), label=None)).decode()

    def provision(self, api, owner_token: str, org: str) -> dict:
        from datetime import datetime, timedelta, timezone
        device = uid()
        receipt = self.gateway.post('provision', owner_token, {'organization_id': org, 'request_id': uid(), 'device_id': device,
                                    'name': 'Kiosco sintético H7', 'expires_at': (datetime.now(timezone.utc) + timedelta(days=30)).isoformat(),
                                    'delivery_key': self.jwk}, 'kiosk.provision', None, mutation=True)
        access = json.loads(self.open(receipt['delivery']))
        return {'id': device, 'email': access['email'], 'password': access['password'], 'token': api.token(access['email'], access['password'])}

    def reset_pin(self, owner_token: str, org: str, employee: str) -> str:
        reset = self.gateway.post('reset', owner_token, {'organization_id': org, 'request_id': uid(), 'employee_id': employee,
                                  'delivery_key': self.jwk}, 'kiosk.reset', None, mutation=True)
        return self.open(reset['delivery'])


def make_tenant(suite: Suite, api, prov, workers: int = 1, admins: int = 0, timezone_name: str = 'Europe/Madrid') -> dict:
    owner = prov.account('owner')
    org = uid()
    owner['membership'] = prov.bootstrap(org, owner['id'])
    owner['token'] = api.token(owner['email'], owner['password'])
    suite.remember(owner['email'], owner['password'], org)
    policy = prov.rpc('create_work_policy', owner['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_timezone': timezone_name,
                      'p_break_counts_as_work': False})['id']
    people = []
    for role in ['EMPLOYEE'] * workers + ['ADMIN'] * admins:
        person = prov.account(role.lower())
        token = secrets.token_hex(32)
        prov.rpc('create_invitation', owner['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_email': person['email'],
                 'p_role': role, 'p_token_hash': hashlib.sha256(token.encode()).hexdigest()})
        person['token'] = api.token(person['email'], person['password'])
        person['membership'] = prov.rpc('accept_invitation', person['token'], {'p_organization_id': org, 'p_request_id': uid(), 'p_token': token})['id']
        person['role'] = role
        if role == 'EMPLOYEE':
            person['employee'], person['code'] = prov.employee(org, owner['token'], person['membership'], policy)
            suite.remember(person['employee'], person['code'])
        suite.remember(person['email'], person['password'])
        people.append(person)
    return {'org': org, 'owner': owner, 'policy': policy, 'workers': [p for p in people if p['role'] == 'EMPLOYEE'],
            'admins': [p for p in people if p['role'] == 'ADMIN']}


def kiosk_employee(suite: Suite, prov, admin: KioskAdmin, tenant: dict) -> dict:
    employee, code = prov.employee(tenant['org'], tenant['owner']['token'], None, tenant['policy'])
    pin = admin.reset_pin(tenant['owner']['token'], tenant['org'], employee)
    suite.remember(employee, code, pin)
    return {'employee': employee, 'code': code, 'pin': pin}


def leak_scan(suite: Suite, paths: list[Path], extra: dict[str, bytes] | None = None) -> list[tuple[str, str]]:
    import leakscan
    blobs = leakscan.files([str(p) for p in paths])
    blobs.update(extra or {})
    return leakscan.scan(blobs, suite.known)


def history_digest(org: str | None = None) -> str:
    """Byte-level digest of immutable labour evidence and receipts (same shape as OPS-02)."""
    where = 'where t.organization_id=%(o)s' if org else ''
    tables = [('public.time_events', 'id'), ('public.work_sessions', 'id'), ('public.event_adjustments', 'id'),
              ('public.correction_decisions', 'id'), ('public.correction_requests', 'id'), ('private.idempotency_records', 'key')]
    parts = ",".join(f"(select coalesce(string_agg(row_to_json(t)::text,'' order by t.{key}),'') from {table} t {where})" for table, key in tables)
    return one(f'select md5(concat_ws(chr(1),{parts}))', {'o': org} if org else {})


def network_digest(secret: str, tenant: str, peer: str) -> str:
    import hmac
    return hmac.new(base64.b64decode(secret), f'kiosk-network-v1\n{tenant.lower()}\n{peer}'.encode(), hashlib.sha256).hexdigest()


def reset_opslog(path: Path) -> None:
    opslib.LOG.path = str(path)

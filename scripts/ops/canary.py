"""OBS-04 synthetic canary: OUT → CLOCK_IN → WORKING → BREAK_START → PAUSED →
BREAK_END → WORKING → CLOCK_OUT → OUT through the web RPC and the kiosk gateway.

Only a synthetic tenant, synthetic identities and a synthetic policy are used;
a real employee can never be a probe (the canary identity is only a member of
its synthetic tenant and RLS limits it to its own employee). Every step checks
response, state, version, server timestamp, RLS, audit and idempotency, and
the confirmed last operation is retried with the same request_id.

History is immutable: the canary never deletes or closes anything. If a
previous run stopped mid-cycle, the synthetic employee is rotated (a new
synthetic employee is linked) and the open synthetic session stays as it is.
Provisioning is CI/local only (operator SQL + Auth admin on loopback).
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import secrets
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import LOG, HttpError, OpsError, Timer, classify_exception, http_json, loopback, now_iso, release_info, write_private  # noqa: E402
from retry import Operation, RetryPolicy, execute, NotRetryable, RetryExhausted  # noqa: E402

CYCLE = [('CLOCK_IN', 'WORKING'), ('BREAK_START', 'PAUSED'), ('BREAK_END', 'WORKING'), ('CLOCK_OUT', 'OUT')]
RECEIPT_KEYS = {'event_id', 'session_id', 'server_at', 'state', 'version', 'sequence', 'request_id'}
POLICY = RetryPolicy(max_attempts=3, base_delay_ms=200, max_delay_ms=1000)


def uid() -> str:
    return str(uuid.uuid4())


def check(condition, stage: str) -> None:
    if not condition:
        raise OpsError('ASSERTION', stage)


class Api:
    def __init__(self, api_url: str, anon: str, timeout: float = 10.0):
        self.url = api_url.rstrip('/')
        self.anon = anon
        self.timeout = timeout

    def headers(self, token: str | None = None) -> dict:
        return {'apikey': self.anon, 'Authorization': 'Bearer ' + (token or self.anon)}

    def get(self, path: str, token: str, component='canary', operation='canary.verify'):
        op = Operation(component, operation, idempotent=True, mutation=False)
        return execute(op, lambda _p, _n: http_json('GET', self.url + path, self.headers(token), None, self.timeout)[1], POLICY)

    def rpc(self, name: str, token: str, args: dict, operation: str, mutation: bool, key: str | None = None):
        body = json.dumps(args, sort_keys=True).encode()
        op = Operation('canary', operation, idempotent=True, mutation=mutation, payload=body, key=key)
        return execute(op, lambda payload, _n: http_json('POST', f'{self.url}/rest/v1/rpc/{name}', self.headers(token), payload, self.timeout)[1], POLICY)

    def token(self, email: str, password: str) -> str:
        _, session = http_json('POST', self.url + '/auth/v1/token?grant_type=password', {'apikey': self.anon},
                               json.dumps({'email': email, 'password': password}).encode(), self.timeout)
        return session['access_token']


class Gateway:
    """Kiosk gateway reached through the application origin (same-origin proxy)."""

    def __init__(self, base_url: str, timeout: float = 15.0):
        self.url = base_url.rstrip('/')
        self.timeout = timeout

    def post(self, route: str, token: str, body: dict, operation: str, key: str | None, mutation: bool):
        data = json.dumps(body, sort_keys=True).encode()
        op = Operation('canary', operation, idempotent=mutation, mutation=mutation, payload=data, key=key)
        return execute(op, lambda payload, _n: http_json('POST', f'{self.url}/{route}', {'Authorization': 'Bearer ' + token}, payload, self.timeout)[1],
                       POLICY)


def parse_time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def validate_receipt(receipt, request_id: str, state: str, version: int, previous_at: datetime | None,
                     window: tuple[datetime, datetime], skew: timedelta) -> datetime:
    check(isinstance(receipt, dict) and set(receipt) == RECEIPT_KEYS, 'response')
    check(receipt['request_id'] == request_id, 'response')
    check(receipt['state'] == state, 'state')
    check(receipt['version'] == version, 'version')
    at = parse_time(receipt['server_at'])
    check(window[0] - skew <= at <= window[1] + skew, 'server_at')
    check(previous_at is None or at >= previous_at, 'server_at')
    return at


class Canary:
    def __init__(self, state: dict, api: Api, gateway: Gateway | None, skew_s: float = 5.0, provisioner: 'Provisioner | None' = None):
        self.s = state
        self.api = api
        self.gateway = gateway
        self.skew = timedelta(seconds=skew_s)
        self.provisioner = provisioner

    # -- shared verifications -------------------------------------------------
    def verify_audit_and_uniqueness(self, owner: str, request_id: str, event_id: str, action: str, kind: str) -> None:
        rows = self.api.get(f'/rest/v1/audit_log?select=action,entity_id,actor_kind&request_id=eq.{request_id}', owner)
        check(isinstance(rows, list) and len(rows) == 1 and rows[0]['entity_id'] == event_id and rows[0]['action'] == action
              and rows[0]['actor_kind'] == kind, 'audit')
        events = self.api.get(f'/rest/v1/time_events?select=id&request_id=eq.{request_id}', owner)
        check(events == [{'id': event_id}], 'idempotency')

    def verify_isolation(self, token: str, own_event: str | None) -> None:
        control = self.s['control']
        foreign = self.api.get(f'/rest/v1/time_events?select=id&organization_id=eq.{control["org"]}', token)
        check(foreign == [], 'rls')
        try:
            self.api.rpc('get_employee_state', token, {'p_organization_id': control['org'], 'p_employee_id': control['employee']},
                         'rpc.get_employee_state', mutation=False)
            raise OpsError('ASSERTION', 'rls')
        except NotRetryable as error:
            check(error.error_class == 'FORBIDDEN', 'rls')
        if own_event:
            own = self.api.get(f'/rest/v1/time_events?select=id&id=eq.{own_event}', token)
            check(own == [{'id': own_event}], 'rls')

    # -- web channel ------------------------------------------------------------
    def rotate_web(self, owner: str) -> None:
        """Link a fresh synthetic employee; the old one keeps its open session."""
        t = self.s['tenant']
        rows = self.api.get(f'/rest/v1/employees?select=version&id=eq.{t["employee"]}', owner)
        check(len(rows) == 1, 'rotate')
        self.api.rpc('manage_employee', owner, {'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': t['employee'],
                     'p_expected_version': rows[0]['version'], 'p_code': 'canary-' + secrets.token_hex(4), 'p_display_name': 'Canary sintético',
                     'p_membership_id': None, 'p_active': False}, 'rpc.manage_employee', mutation=True, key=None)
        fresh = uid()
        self.api.rpc('manage_employee', owner, {'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': fresh,
                     'p_expected_version': 0, 'p_code': 'canary-' + secrets.token_hex(4), 'p_display_name': 'Canary sintético',
                     'p_membership_id': t['membership'], 'p_active': True}, 'rpc.manage_employee', mutation=True, key=None)
        self.api.rpc('assign_work_policy', owner, {'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': fresh,
                     'p_policy_id': t['policy']}, 'rpc.assign_work_policy', mutation=True, key=None)
        t['employee'] = fresh
        LOG.emit('canary', 'canary.rotate', 'success', channel='web')

    def run_web(self) -> dict:
        t = self.s['tenant']
        worker = self.api.token(t['worker']['email'], t['worker']['password'])
        owner = self.api.token(t['owner']['email'], t['owner']['password'])
        rotated = False
        state = self.api.rpc('get_employee_state', worker, {'p_organization_id': t['org'], 'p_employee_id': t['employee']},
                             'rpc.get_employee_state', mutation=False)
        if state['state'] != 'OUT':
            self.rotate_web(owner)
            rotated = True
            state = self.api.rpc('get_employee_state', worker, {'p_organization_id': t['org'], 'p_employee_id': t['employee']},
                                 'rpc.get_employee_state', mutation=False)
            check(state['state'] == 'OUT', 'state')
        self.verify_isolation(worker, None)
        version, previous_at, steps, last = state['version'], None, [], None
        for action, expected in CYCLE:
            request_id = uid()
            args = {'p_organization_id': t['org'], 'p_request_id': request_id, 'p_employee_id': t['employee'],
                    'p_action': action, 'p_expected_version': version}
            timer, before = Timer(), datetime.now(timezone.utc)
            receipt = self.api.rpc('record_time_event', worker, args, f'clock.{action}', mutation=True, key=request_id)
            previous_at = validate_receipt(receipt, request_id, expected, version + 1, previous_at, (before, datetime.now(timezone.utc)), self.skew)
            replay = self.api.rpc('record_time_event', worker, args, f'clock.{action}', mutation=True, key=request_id)
            check(replay == receipt, 'idempotency')
            now = self.api.rpc('get_employee_state', worker, {'p_organization_id': t['org'], 'p_employee_id': t['employee']},
                               'rpc.get_employee_state', mutation=False)
            check(now['state'] == expected and now['version'] == version + 1, 'state')
            self.verify_isolation(worker, receipt['event_id'])
            self.verify_audit_and_uniqueness(owner, request_id, receipt['event_id'], 'record_time_event', 'USER')
            steps.append({'operation': f'clock.{action}', 'request_id': request_id, 'duration_ms': timer.ms})
            version, last = version + 1, (args, receipt)
        # Safe retry of an already confirmed operation: same key, same receipt, no mutation.
        again = self.api.rpc('record_time_event', worker, last[0], 'clock.CLOCK_OUT', mutation=True, key=last[0]['p_request_id'])
        check(again == last[1], 'idempotency')
        final = self.api.rpc('get_employee_state', worker, {'p_organization_id': t['org'], 'p_employee_id': t['employee']},
                             'rpc.get_employee_state', mutation=False)
        check(final['state'] == 'OUT' and final['version'] == version, 'version')
        return {'status': 'PASS', 'steps': steps, 'rotated': rotated}

    # -- kiosk channel ------------------------------------------------------------
    def run_kiosk(self) -> dict:
        k, t = self.s['kiosk'], self.s['tenant']
        check(self.gateway is not None, 'config')
        device = self.api.token(k['device_email'], k['device_password'])
        owner = self.api.token(t['owner']['email'], t['owner']['password'])
        check(self.api.get('/rest/v1/time_events?select=id', device) == [], 'rls')
        steps, previous_at, rotated = [], None, False
        for index, (action, expected) in enumerate(CYCLE):
            auth = {'organization_id': t['org'], 'device_id': k['device_id'], 'code': k['code'], 'pin': k['pin']}
            offer = self.gateway.post('authenticate', device, auth, 'kiosk.authenticate', None, mutation=False)
            if index == 0 and offer.get('state') != 'OUT':
                self.rotate_kiosk(owner)
                rotated = True
                auth.update(code=k['code'], pin=k['pin'])
                offer = self.gateway.post('authenticate', device, auth, 'kiosk.authenticate', None, mutation=False)
            check(isinstance(offer, dict) and set(offer) == {'state', 'version', 'actions', 'challenges'}, 'response')
            challenge = next((c for c in offer['challenges'] if c['action'] == action), None)
            check(challenge is not None and action in offer['actions'], 'state')
            body = {'organization_id': t['org'], 'device_id': k['device_id'], 'request_id': challenge['request_id'],
                    'challenge': challenge['challenge'], 'action': action, 'expected_version': offer['version']}
            timer, before = Timer(), datetime.now(timezone.utc)
            receipt = self.gateway.post('record', device, body, f'clock.{action}', challenge['request_id'], mutation=True)
            previous_at = validate_receipt(receipt, challenge['request_id'], expected, offer['version'] + 1, previous_at,
                                           (before, datetime.now(timezone.utc)), self.skew)
            replay = self.gateway.post('record', device, body, f'clock.{action}', challenge['request_id'], mutation=True)
            check(replay == receipt, 'idempotency')
            self.verify_audit_and_uniqueness(owner, challenge['request_id'], receipt['event_id'], 'kiosk_record_event', 'KIOSK')
            steps.append({'operation': f'clock.{action}', 'request_id': challenge['request_id'], 'duration_ms': timer.ms})
        return {'status': 'PASS', 'steps': steps, 'rotated': rotated}

    def rotate_kiosk(self, owner: str) -> None:
        """A new synthetic kiosk employee (needs PIN provisioning rights)."""
        if self.provisioner is None:
            raise OpsError('ASSERTION', 'rotate')
        k, t = self.s['kiosk'], self.s['tenant']
        employee, code = self.provisioner.employee(t['org'], owner, None, t['policy'])
        k.update(employee=employee, code=code, pin=self.provisioner.reset_pin(owner, t['org'], employee, k))
        LOG.emit('canary', 'canary.rotate', 'success', channel='kiosk')

    def run(self, channels=('web', 'kiosk')) -> dict:
        timer = Timer()
        report = {'status': 'PASS', 'channels': {}, 'generated_at': now_iso()}
        for channel in channels:
            try:
                result = self.run_web() if channel == 'web' else self.run_kiosk()
            except (NotRetryable, RetryExhausted, OpsError, HttpError) as error:
                cls = getattr(error, 'last_class', None) or getattr(error, 'error_class', 'INTERNAL')
                result = {'status': 'FAIL', 'error_class': cls, 'failed_step': LOG.events[-1]['operation'] if LOG.events else 'canary.run',
                          'stage': getattr(error, 'stage', 'unknown')}
            except (KeyError, TypeError, ValueError):
                result = {'status': 'FAIL', 'error_class': 'INVALID_RESPONSE', 'failed_step': 'canary.verify', 'stage': 'response'}
            except OSError as error:   # dependency unreachable before any retry wrapper
                result = {'status': 'FAIL', 'error_class': classify_exception(error), 'failed_step': 'canary.run', 'stage': 'network'}
            report['channels'][channel] = result
            LOG.emit('canary', 'canary.run', 'success' if result['status'] == 'PASS' else 'failure', channel=channel,
                     state=result['status'], error_class=result.get('error_class', 'NONE'))
        report['status'] = 'PASS' if all(c['status'] == 'PASS' for c in report['channels'].values()) else 'FAIL'
        release, commit = release_info()
        report.update(release=release, commit=commit, duration_ms=timer.ms)
        return report


# --- Synthetic operator provisioning (local/staging/production, guarded) --------
class Provisioner:
    """Creates synthetic tenants/identities. Loopback targets only."""

    def __init__(self, api: Api, service_key: str, operator_dsn: str, gateway: Gateway | None):
        if not self.allowed(api.url, operator_dsn):
            raise OpsError('CONFIG', 'provision')
        self.api, self.service, self.dsn, self.gateway = api, service_key, operator_dsn, gateway

    @staticmethod
    def _dsn_settings(operator_dsn: str) -> dict[str, str]:
        """Parse only authority fields needed by the environment guard.
        Remote canaries must carry host/sslmode explicitly: an opaque service-only
        DSN is refused because its actual database target cannot be pinned here."""
        import shlex
        from urllib.parse import parse_qs, urlparse

        if operator_dsn.startswith(('postgresql://', 'postgres://')):
            parsed = urlparse(operator_dsn)
            query = parse_qs(parsed.query)
            return {'host': parsed.hostname or '', 'sslmode': query.get('sslmode', [''])[0]}
        try:
            tokens = shlex.split(operator_dsn)
        except ValueError:
            return {}
        values: dict[str, str] = {}
        for token in tokens:
            if '=' not in token:
                return {}
            key, value = token.split('=', 1)
            if key in ('host', 'sslmode'):
                values[key] = value
        return values

    @staticmethod
    def allowed(api_url: str, operator_dsn: str) -> bool:
        """Loopback (CI/local), or an explicitly pinned synthetic staging/production
        pair. API and database are pinned independently and TLS verify-full is
        mandatory so operator credentials cannot provision a different project."""
        if loopback(api_url):
            return '127.0.0.1' in operator_dsn or 'localhost' in operator_dsn
        import os
        from urllib.parse import urlparse

        environment = os.environ.get('FICHAJE_ENV')
        if environment not in ('staging', 'production'):
            return False
        parsed = urlparse(api_url)
        if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.query or parsed.fragment \
                or parsed.path not in ('', '/') or not parsed.hostname:
            return False
        prefix = 'STAGING' if environment == 'staging' else 'PRODUCTION'
        api_host = os.environ.get(f'FICHAJE_{prefix}_API_HOST', '')
        db_host = os.environ.get(f'FICHAJE_{prefix}_DB_HOST', '')
        dsn = Provisioner._dsn_settings(operator_dsn)
        return bool(api_host and db_host and parsed.hostname == api_host
                    and dsn.get('host') == db_host and dsn.get('sslmode') == 'verify-full')

    def account(self, label: str) -> dict:
        email = f'canary-{label}-{secrets.token_hex(6)}@example.invalid'
        password = secrets.token_urlsafe(32)
        _, user = http_json('POST', self.api.url + '/auth/v1/admin/users', {'apikey': self.service, 'Authorization': 'Bearer ' + self.service},
                            json.dumps({'email': email, 'password': password, 'email_confirm': True}).encode())
        return {'id': user['id'], 'email': email, 'password': password}

    def bootstrap(self, org: str, owner_id: str) -> str:
        import psycopg
        with psycopg.connect(self.dsn) as connection:
            connection.execute('select private.bootstrap_organization(%s,%s,%s,%s)', (org, 'Canary sintético OPS-02', owner_id, uid()))
            return str(connection.execute('select id from public.memberships where organization_id=%s and auth_user_id=%s', (org, owner_id)).fetchone()[0])

    def rpc(self, name, token, args):
        return self.api.rpc(name, token, args, 'rpc.other', mutation=True, key=None)

    def employee(self, org: str, owner: str, membership: str | None, policy: str) -> tuple[str, str]:
        employee, code = uid(), 'canary-' + secrets.token_hex(4)
        self.rpc('manage_employee', owner, {'p_organization_id': org, 'p_request_id': uid(), 'p_employee_id': employee, 'p_expected_version': 0,
                 'p_code': code, 'p_display_name': 'Canary sintético', 'p_membership_id': membership, 'p_active': True})
        self.rpc('assign_work_policy', owner, {'p_organization_id': org, 'p_request_id': uid(), 'p_employee_id': employee, 'p_policy_id': policy})
        return employee, code

    def reset_pin(self, owner: str, org: str, employee: str, kiosk: dict) -> str:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import padding
        reset = self.gateway.post('reset', owner, {'organization_id': org, 'request_id': uid(), 'employee_id': employee,
                                  'delivery_key': kiosk['jwk']}, 'kiosk.reset', None, mutation=True)
        key = serialization.load_pem_private_key(kiosk['private_key'].encode(), password=None)
        return key.decrypt(base64.b64decode(reset['delivery']), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),
                                                                           algorithm=hashes.SHA256(), label=None)).decode()

    def provision(self) -> dict:
        from cryptography.hazmat.primitives.asymmetric import rsa, padding
        from cryptography.hazmat.primitives import hashes, serialization
        owner, worker, control_owner = self.account('owner'), self.account('worker'), self.account('control')
        org, control_org = uid(), uid()
        self.bootstrap(org, owner['id'])
        control_membership = self.bootstrap(control_org, control_owner['id'])
        owner_token = self.api.token(owner['email'], owner['password'])
        invitation = secrets.token_hex(32)
        self.rpc('create_invitation', owner_token, {'p_organization_id': org, 'p_request_id': uid(), 'p_email': worker['email'],
                 'p_role': 'EMPLOYEE', 'p_token_hash': hashlib.sha256(invitation.encode()).hexdigest()})
        worker_token = self.api.token(worker['email'], worker['password'])
        membership = self.rpc('accept_invitation', worker_token, {'p_organization_id': org, 'p_request_id': uid(), 'p_token': invitation})['id']
        policy = self.rpc('create_work_policy', owner_token, {'p_organization_id': org, 'p_request_id': uid(), 'p_timezone': 'Europe/Madrid',
                          'p_break_counts_as_work': False})['id']
        employee, _ = self.employee(org, owner_token, membership, policy)
        control_token = self.api.token(control_owner['email'], control_owner['password'])
        control_policy = self.rpc('create_work_policy', control_token, {'p_organization_id': control_org, 'p_request_id': uid(),
                                  'p_timezone': 'Atlantic/Canary', 'p_break_counts_as_work': True})['id']
        control_employee, _ = self.employee(control_org, control_token, control_membership, control_policy)
        self.rpc('record_time_event', control_token, {'p_organization_id': control_org, 'p_request_id': uid(), 'p_employee_id': control_employee,
                 'p_action': 'CLOCK_IN', 'p_expected_version': 0})
        state = {'synthetic': True, 'tenant': {'org': org, 'owner': {'email': owner['email'], 'password': owner['password']},
                                               'worker': {'email': worker['email'], 'password': worker['password']},
                                               'membership': membership, 'employee': employee, 'policy': policy},
                 'control': {'org': control_org, 'employee': control_employee}}
        if self.gateway is not None:
            key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
            numbers = key.public_key().public_numbers()
            b64 = lambda i: base64.urlsafe_b64encode(i.to_bytes((i.bit_length() + 7) // 8, 'big')).decode().rstrip('=')  # noqa: E731
            jwk = {'kty': 'RSA', 'n': b64(numbers.n), 'e': b64(numbers.e), 'alg': 'RSA-OAEP-256', 'ext': True}
            open_ = lambda c: key.decrypt(base64.b64decode(c), padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)).decode()  # noqa: E731
            device = uid()
            receipt = self.gateway.post('provision', owner_token, {'organization_id': org, 'request_id': uid(), 'device_id': device,
                                        'name': 'Canary sintético', 'expires_at': (datetime.now(timezone.utc) + timedelta(days=365)).isoformat(),
                                        'delivery_key': jwk}, 'kiosk.provision', None, mutation=True)
            access = json.loads(open_(receipt['delivery']))
            kiosk_employee, code = self.employee(org, owner_token, None, policy)
            pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
            state['kiosk'] = {'device_id': device, 'device_email': access['email'], 'device_password': access['password'],
                              'employee': kiosk_employee, 'code': code, 'jwk': jwk, 'private_key': pem}
            state['kiosk']['pin'] = self.reset_pin(owner_token, org, kiosk_employee, state['kiosk'])
        LOG.emit('canary', 'canary.provision', 'success')
        return state


if __name__ == '__main__':
    import os
    parser = argparse.ArgumentParser(description='OPS-02 synthetic canary (credentials only via environment variables)')
    parser.add_argument('command', choices=['provision', 'run'])
    parser.add_argument('--state', required=True, help='synthetic state file (0600, never committed or uploaded)')
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--gateway-url', help='kiosk gateway base URL, e.g. <app>/gateway/kiosk')
    parser.add_argument('--channels', default='web,kiosk')
    parser.add_argument('--out')
    args = parser.parse_args()
    api = Api(args.api_url, os.environ['SUPABASE_ANON_KEY'])
    gateway = Gateway(args.gateway_url) if args.gateway_url else None
    path = Path(args.state)
    if args.command == 'provision':
        state = Provisioner(api, os.environ['SUPABASE_SERVICE_ROLE_KEY'], os.environ['OPS_OPERATOR_DSN'], gateway).provision()
        write_private(path, json.dumps(state))
        print(json.dumps({'status': 'PROVISIONED'}))
        sys.exit(0)
    state = json.loads(path.read_text(encoding='utf-8'))
    canary = Canary(state, api, gateway)
    report = canary.run(tuple(args.channels.split(',')))
    write_private(path, json.dumps(canary.s))
    safe = {'status': report['status'], 'channels': {c: {k: v for k, v in r.items() if k != 'steps'} for c, r in report['channels'].items()}}
    if args.out:
        Path(args.out).write_text(json.dumps(safe, sort_keys=True) + '\n', encoding='utf-8')
    print(json.dumps(safe, sort_keys=True))
    sys.exit(0 if report['status'] == 'PASS' else 2)

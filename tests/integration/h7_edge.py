"""H7 same-origin edge, ingress and SEC-H4-01 behind a real proxy (staging-like, local).

The built app and the /gateway Pages Function run in the real Cloudflare Pages
runtime (workerd via the pinned wrangler of edge/); the kiosk gateway and the
export-link signer are the real Deno functions with an ingress secret, against
the local ephemeral Supabase stack. Synthetic tenants only. This is NOT the
remote staging: it proves the code paths and the proxy behaviour that staging
must then confirm on Cloudflare + Supabase.
"""
import base64
import hashlib
import hmac
import http.client as httpclient
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from h7_support import (ROOT, KioskAdmin, Processes, Suite, build_dist, canary_mod, drop_logins, functions_env, history_digest, http,  # noqa: E402
                        http_json, kiosk_employee, leak_scan, login, make_tenant, network_digest, one, reset_opslog, rows, secret_b64,
                        stack, start_edge, start_functions, uid)

suite = Suite('h7-edge')
check = suite.check
S = stack()
suite.remember(S['service'])
api = canary_mod.Api(S['url'], S['anon'])
reset_opslog(suite.scratch / 'ops-events.jsonl')
processes = Processes(suite.scratch / 'logs')
KIOSK_PORT, EXPORT_PORT, EDGE_PORT = 8766, 8002, 8788


def sign(secret_b64_value: str, ts: int, method: str, component: str, route: str, body: bytes) -> str:
    """Python mirror of supabase/functions/_shared/ingress.ts (interoperability check)."""
    digest = hashlib.sha256(body).hexdigest()
    canonical = f'fichaje-edge-v1\n{ts}\n{method}\n{component}\n{route}\n{digest}'.encode()
    return f'v1.{ts}.' + hmac.new(base64.b64decode(secret_b64_value), canonical, hashlib.sha256).hexdigest()


def headers_file(dist: Path) -> dict:
    """Parses dist/_headers into {pattern: {header: value}} (detach lines ignored)."""
    rules, current = {}, None
    for line in (dist / '_headers').read_text(encoding='utf-8').splitlines():
        if line and not line.startswith(' '):
            current = rules.setdefault(line.strip(), {})
        elif line.strip() and not line.strip().startswith('!'):
            key, value = line.strip().split(':', 1)
            current[key.strip().lower()] = value.strip()
    return rules


def static_policy(edge: str, dist: Path) -> None:
    declared = headers_file(dist)
    check(set(declared) == {'/*', '/assets/*'} and json.loads((dist / '_routes.json').read_text()) == {'version': 1, 'include': ['/gateway/*'], 'exclude': []},
          'EDGE build emits the static header policy and a /gateway-only function route table')
    status, head, body = http('GET', edge + '/')
    html = body.decode()
    check(status == 200 and '<meta name="fichaje-release" content="h7-edge"' in html, 'EDGE workerd serves the built shell with its release identity')
    for name in ('content-security-policy', 'strict-transport-security', 'x-frame-options', 'referrer-policy', 'permissions-policy',
                 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'x-robots-tag', 'cache-control'):
        check(head.get(name) == declared['/*'][name], f'EDGE static header {name} served exactly as declared (no merge or duplicate)')
    check("frame-ancestors 'none'" in head['content-security-policy'] and "script-src 'self'" in head['content-security-policy']
          and f"connect-src 'self' {S['url']}" in head['content-security-policy'], 'EDGE CSP: same-origin scripts, Supabase-only connect, no framing')
    check(head.get('x-content-type-options') == 'nosniff', 'EDGE nosniff present once')
    check('access-control-allow-origin' not in head, 'EDGE static responses carry no default open CORS header')
    status, head, body = http('GET', edge + '/kiosco')
    check(status == 200 and b'id="root"' in body and head.get('cache-control') == 'no-cache' and 'access-control-allow-origin' not in head,
          'EDGE /kiosco is the revalidated SPA shell with the same policy')
    entry = re.search(r'src="(/assets/index-[^"]+\.js)"', html).group(1)
    status, head, body = http('GET', edge + entry)
    check(status == 200 and head.get('cache-control') == 'public, max-age=31536000, immutable' and 'access-control-allow-origin' not in head,
          'EDGE hashed assets immutable, without CORS')
    check(http('GET', edge + '/sw.js')[1].get('cache-control') == 'no-cache', 'EDGE service worker script always revalidated')
    maps = [p for p in dist.rglob('*') if p.suffix == '.map']
    sourcemap_refs = [p for p in dist.rglob('*.js') if b'sourceMappingURL' in p.read_bytes()]
    check(not maps and not sourcemap_refs, 'EDGE build ships no source maps')
    scan = subprocess.run(['node', 'scripts/scan_secrets.mjs', str(dist)], cwd=ROOT, capture_output=True, text=True)
    check(scan.returncode == 0, 'EDGE bundle secret scan: 0 findings')
    blob = b''.join(p.read_bytes() for p in dist.rglob('*') if p.is_file())
    check(not any(v.encode() in blob for v in suite.known), 'EDGE no server secret, key, DSN or synthetic credential in the static bundle')


def gateway_contract(edge: str, device_token: str) -> None:
    for component in ('kiosk', 'export-link'):
        for probe in ('live', 'ready'):
            status, head, data = http_json('GET', f'{edge}/gateway/{component}/health/{probe}')
            check(status == 200 and data['status'] == 'UP' and head.get('cache-control') == 'no-store, max-age=0'
                  and 'access-control-allow-origin' not in head, f'EDGE {component} /health/{probe} UP through the signed proxy, no-store')
    cases = [('POST', '/gateway/kiosk/debug', 404), ('POST', '/gateway/admin', 404), ('POST', '/gateway/kiosk/record?x=1', 404),
             ('GET', '/gateway/kiosk/record', 405), ('POST', '/gateway/kiosk/health/ready', 405), ('PUT', '/gateway/export-link', 405)]
    for method, path, expected in cases:
        status, head, _ = http(method, edge + path, {'Content-Type': 'application/json'}, b'{}')
        check(status == expected and head.get('cache-control') == 'no-store, max-age=0', f'EDGE {method} {path} → {expected}, no-store')
    status, head, _ = http('OPTIONS', edge + '/gateway/kiosk/authenticate', {'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST',
                                                                            'Access-Control-Request-Headers': 'authorization,content-type'})
    check(status == 405 and not any(k.startswith('access-control-') for k in head), 'EDGE CORS preflight refused without any Access-Control header')
    auth = {'Authorization': 'Bearer ' + device_token, 'Content-Type': 'application/json'}
    body = json.dumps({'organization_id': uid(), 'device_id': uid(), 'code': 'x', 'pin': '00000000'}).encode()
    for extra, label in (({'Origin': 'https://evil.example'}, 'foreign Origin'), ({'Sec-Fetch-Site': 'cross-site'}, 'cross-site fetch'),
                         ({'Sec-Fetch-Site': 'same-site'}, 'same-site fetch')):
        status, head, _ = http('POST', edge + '/gateway/kiosk/authenticate', {**auth, **extra}, body)
        check(status == 403 and 'access-control-allow-origin' not in head, f'EDGE {label} refused before the gateway')
    check(http('POST', edge + '/gateway/kiosk/authenticate', {**auth, 'Content-Type': 'text/plain'}, body)[0] == 415, 'EDGE non-JSON body refused')
    check(http('POST', edge + '/gateway/kiosk/authenticate', auth, b'{' + b' ' * 8192 + b'}')[0] == 413, 'EDGE kiosk body > 8 KiB refused')
    check(http('POST', edge + '/gateway/export-link', auth, b'{' + b' ' * 1024 + b'}')[0] == 413, 'EDGE signer body > 1 KiB refused')
    # A chunked body without Content-Length is cut at the limit as well.
    connection = httpclient.HTTPConnection('127.0.0.1', EDGE_PORT, timeout=20)
    connection.putrequest('POST', '/gateway/kiosk/authenticate')
    for key, value in auth.items():
        connection.putheader(key, value)
    connection.putheader('Transfer-Encoding', 'chunked')
    connection.endheaders()
    for _ in range(9):
        connection.send(b'400\r\n' + b' ' * 1024 + b'\r\n')
    connection.send(b'0\r\n\r\n')
    check(connection.getresponse().status == 413, 'EDGE chunked body over the limit refused')
    connection.close()


def bypass(ingress: str, tenant: dict, device: dict, worker: dict) -> None:
    kiosk, signer = f'http://127.0.0.1:{KIOSK_PORT}', f'http://127.0.0.1:{EXPORT_PORT}'
    before = rows('select count(*),coalesce(sum(failures),0) from private.auth_attempt_buckets where organization_id=%s', (tenant['org'],))[0]
    before_net = rows('select count(*),coalesce(sum(failures),0) from private.kiosk_network_buckets where organization_id=%s', (tenant['org'],))[0]
    body = json.dumps({'organization_id': tenant['org'], 'device_id': device['id'], 'code': 'bypass-code', 'pin': '12345678'}).encode()
    auth = {'Authorization': 'Bearer ' + device['token'], 'Content-Type': 'application/json'}
    now = int(time.time())
    attempts = {
        'no signature': {},
        'stale signature (120 s)': {'x-fichaje-edge': sign(ingress, now - 120, 'POST', 'kiosk', 'authenticate', body)},
        'future signature (120 s)': {'x-fichaje-edge': sign(ingress, now + 120, 'POST', 'kiosk', 'authenticate', body)},
        'signature for another route': {'x-fichaje-edge': sign(ingress, now, 'POST', 'kiosk', 'record', body)},
        'signature for other bytes': {'x-fichaje-edge': sign(ingress, now, 'POST', 'kiosk', 'authenticate', body + b' ')},
        'signature with another secret': {'x-fichaje-edge': sign(secret_b64(), now, 'POST', 'kiosk', 'authenticate', body)},
        'malformed signature': {'x-fichaje-edge': 'v1.' + str(now) + '.zz'},
    }
    for label, extra in attempts.items():
        status, _, data = http_json('POST', kiosk + '/authenticate', {**auth, **extra}, json.loads(body))
        check((status, data) == (403, {'error': 'AUTH_FAILED'}), f'BYPASS direct gateway call refused: {label}')
    after = rows('select count(*),coalesce(sum(failures),0) from private.auth_attempt_buckets where organization_id=%s', (tenant['org'],))[0]
    after_net = rows('select count(*),coalesce(sum(failures),0) from private.kiosk_network_buckets where organization_id=%s', (tenant['org'],))[0]
    check(before == after and before_net == after_net, 'BYPASS refused before any SQL: no PIN attempt or network failure was counted')
    check(http('GET', kiosk + '/health/ready')[0] == 403 and http('GET', signer + '/health/ready')[0] == 403,
          'BYPASS direct health probes refused (only the edge reaches the functions)')
    status, _, data = http_json('POST', signer, {'Authorization': 'Bearer ' + worker['token']}, {'organization_id': tenant['org'], 'job_id': uid()})
    check((status, data) == (403, {'error': 'FORBIDDEN'}), 'BYPASS direct signer call refused')
    # The Python mirror of the contract is accepted: same canonical form on both sides.
    signed = sign(ingress, int(time.time()), 'GET', 'kiosk', 'health/live', b'')
    check(http('GET', kiosk + '/health/live', {'x-fichaje-edge': signed})[0] == 200, 'INGRESS signature contract interoperates (Python ↔ Deno)')
    events = [json.loads(line) for line in (suite.scratch / 'logs' / 'fn-kiosk.log').read_text().splitlines() if line.startswith('{')]
    check(sum(1 for e in events if e.get('stage') == 'ingress' and e['outcome'] == 'rejected' and e['error_class'] == 'FORBIDDEN') >= len(attempts) + 1,
          'OBS-01 every refused direct call is an allowlisted rejected event with stage=ingress')


def flows_through_edge(edge: str) -> dict:
    prov = canary_mod.Provisioner(api, S['service'], 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
                                  canary_mod.Gateway(edge + '/gateway/kiosk'))
    state = prov.provision()
    suite.remember(state['tenant']['owner']['password'], state['tenant']['worker']['password'], state['kiosk']['device_password'],
                   state['kiosk']['pin'], state['kiosk']['code'], state['kiosk']['private_key'])
    report = canary_mod.Canary(state, api, canary_mod.Gateway(edge + '/gateway/kiosk'), provisioner=prov).run()
    check(report['status'] == 'PASS' and report['channels']['kiosk']['status'] == 'PASS' and report['channels']['web']['status'] == 'PASS',
          'EDGE provisioning, PIN delivery and the full web + kiosk canary (idempotent retries included) work through the proxy')
    # Export: request, offline worker, signed link through the edge; a foreign tenant is refused.
    t = state['tenant']
    worker = api.token(t['worker']['email'], t['worker']['password'])
    today = datetime.now(timezone.utc).date().isoformat()
    job = prov.rpc('request_export', worker, {'p_organization_id': t['org'], 'p_request_id': uid(), 'p_employee_id': None,
                                              'p_start': today, 'p_end': today, 'p_timezone': 'Europe/Madrid'})
    status, _, generated = http_json('POST', edge + '/gateway/export-link/generate', {'Authorization': 'Bearer ' + worker},
                                      {'organization_id': t['org'], 'job_id': job['job_id']}, timeout=45)
    check(status == 200 and generated == {'status': 'READY'},
          'EDGE export generated by the server-side product path')
    status, head, data = http_json('POST', edge + '/gateway/export-link', {'Authorization': 'Bearer ' + worker},
                                   {'organization_id': t['org'], 'job_id': job['job_id']})
    check(status == 200 and 1 <= data['expires_in'] <= 300 and head.get('cache-control') == 'no-store, max-age=0',
          'EDGE signed export link through the proxy, TTL ≤ 300 s, no-store')
    suite.remember(data['url'])
    downloaded = http('GET', data['url'])
    check(downloaded[0] == 200 and downloaded[2][:2] == b'PK', 'EDGE signed URL downloads the private package')
    device_token = api.token(state['kiosk']['device_email'], state['kiosk']['device_password'])
    status, _, _ = http_json('POST', edge + '/gateway/export-link', {'Authorization': 'Bearer ' + device_token},
                             {'organization_id': t['org'], 'job_id': job['job_id']})
    check(status == 403, 'EDGE kiosk identity cannot sign an export link')
    return state


def platform_mode_fails_closed(gateway_dsn: str) -> None:
    """Without a local port the functions run in platform mode: no ingress secret, no start (fail closed)."""
    env = {k: v for k, v in functions_env(S, gateway_dsn, secret_b64(), secret_b64(), None, 'h7-edge').items()
           if k not in ('KIOSK_PORT', 'EXPORT_LINK_PORT', 'FICHAJE_INGRESS_SECRET', 'FICHAJE_INGRESS_SECRET_PREVIOUS')}
    source = ROOT / 'supabase' / 'functions'
    commands = [['deno', 'run', '--allow-env', '--allow-net', '--config', str(source / 'kiosk' / 'deno.json'), str(source / 'kiosk' / 'index.ts')],
                ['deno', 'run', '--allow-env', '--allow-net', str(source / 'export-link' / 'index.ts')]]
    refused = []
    for command in commands:
        try:
            result = subprocess.run(command, env=env, cwd=ROOT, capture_output=True, timeout=60)
            refused.append(result.returncode != 0 and b'CONFIG_REQUIRED' in result.stderr)
        except subprocess.TimeoutExpired:   # it started serving: the regression this check exists for
            refused.append(False)
    check(refused == [True, True], 'PLATFORM mode (no local port) without the ingress secret: gateway and signer refuse to start')


def staging_verifier(edge: str, state: dict) -> None:
    """The operator's staging verifier, run for real against the local staging shape (TLS checks skipped)."""
    canary_file = suite.scratch / 'canary-state.json'
    fd = os.open(canary_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        json.dump(state, handle)
    result = subprocess.run([sys.executable, str(ROOT / 'scripts' / 'staging' / 'verify_staging.py'), '--local', '--app-url', edge,
                             '--api-url', S['url'], '--kiosk-direct-url', f'http://127.0.0.1:{KIOSK_PORT}',
                             '--export-link-direct-url', f'http://127.0.0.1:{EXPORT_PORT}', '--canary-state', str(canary_file)],
                            env={**os.environ, 'SUPABASE_ANON_KEY': S['anon']}, capture_output=True, text=True, timeout=300)
    canary_file.unlink()
    (suite.scratch / 'logs' / 'verify-staging.log').write_text(result.stdout + result.stderr)
    report = json.loads(result.stdout)
    skipped = sorted(k for k, v in report['checks'].items() if v.startswith('SKIPPED'))
    failed = sorted(k for k, v in report['checks'].items() if v == 'FAIL')
    for name in failed:   # check names only
        print(f'VERIFY_STAGING_FAIL {name}', file=sys.stderr)
    check(result.returncode == 0 and report['status'] == 'PASS' and failed == []
          and skipped == ['tls_http_redirect', 'tls_https_only', 'tls_version'] and len(report['checks']) >= 30,
          f'STAGING verifier PASS against the local staging shape ({len(report["checks"]) - len(skipped)} checks; only the 3 TLS checks skipped locally)')


def sec_h4_01(edge: str, network: str) -> dict:
    """SEC-H4-01 behind a real proxy: the gateway sees the proxy's TCP peer."""
    prov = canary_mod.Provisioner(api, S['service'], 'postgresql://postgres:postgres@127.0.0.1:54322/postgres', None)
    admin = KioskAdmin(edge + '/gateway/kiosk')
    tenant, control = make_tenant(suite, api, prov, workers=0), make_tenant(suite, api, prov, workers=0)
    devices = [admin.provision(api, tenant['owner']['token'], tenant['org']) for _ in range(3)]
    control_device = admin.provision(api, control['owner']['token'], control['org'])
    for d in devices + [control_device]:
        suite.remember(d['password'])
    person, other = kiosk_employee(suite, prov, admin, tenant), kiosk_employee(suite, prov, admin, control)
    gw = canary_mod.Gateway(edge + '/gateway/kiosk')
    proxy_peer = network_digest(network, tenant['org'], '127.0.0.1')
    spoofed = ['203.0.113.7', '198.51.100.23', '192.0.2.44']

    def attempt(device, code, pin, spoof=None):
        headers = {'Authorization': 'Bearer ' + device['token'], 'Content-Type': 'application/json'}
        if spoof:
            headers.update({'X-Forwarded-For': spoof, 'X-Real-IP': spoof, 'CF-Connecting-IP': spoof, 'True-Client-IP': spoof,
                            'Forwarded': f'for={spoof}'})
        return http_json('POST', edge + '/gateway/kiosk/authenticate', headers,
                         {'organization_id': tenant['org'], 'device_id': device['id'], 'code': code, 'pin': pin})

    started = time.monotonic()
    for i in range(60):
        status, _, data = attempt(devices[i // 20], f'unknown-{i}', '00000000', spoofed[i % 3])
        assert (status, data) == (403, {'error': 'AUTH_FAILED'}), 'failures stay generic'
    elapsed = time.monotonic() - started
    buckets = rows('select subject_hash,failures,locked_until>clock_timestamp() from private.kiosk_network_buckets where organization_id=%s',
                   (tenant['org'],))
    check(len(buckets) == 1 and buckets[0][0] == proxy_peer, 'SEC-H4-01 behind the proxy the gateway sees ONE peer: the proxy loopback address')
    check(not any(network_digest(network, tenant['org'], ip) == b[0] for ip in spoofed for b in buckets),
          'SEC-H4-01 X-Forwarded-For / X-Real-IP / CF-Connecting-IP / True-Client-IP / Forwarded never choose the bucket')
    check(buckets[0][1] == 60 and buckets[0][2], 'SEC-H4-01 60 failures across three devices lock the shared proxy bucket for the tenant')
    check(one('select bool_and(failures=20) from private.auth_attempt_buckets where organization_id=%s and device_id = any(%s::uuid[])',
              (tenant['org'], [d['id'] for d in devices])), 'SEC-H4-01 per-device counters (30/15 min) unchanged: 20 each')
    status, _, data = attempt(devices[2], person['code'], person['pin'])
    check((status, data) == (403, {'error': 'AUTH_FAILED'}),
          'SEC-H4-01 conservative effect measured: with the lock, even a correct PIN on any kiosk of the tenant is refused for 15 min')
    status, _, offer = http_json('POST', edge + '/gateway/kiosk/authenticate', {'Authorization': 'Bearer ' + control_device['token']},
                                 {'organization_id': control['org'], 'device_id': control_device['id'], 'code': other['code'], 'pin': other['pin']})
    check(status == 200 and offer['state'] == 'OUT', 'SEC-H4-01 another tenant behind the same proxy is unaffected (bucket per tenant)')
    with __import__('psycopg').connect('postgresql://postgres:postgres@127.0.0.1:54322/postgres') as connection:
        connection.execute("update private.kiosk_network_buckets set window_start=clock_timestamp()-interval '31 minutes',"
                           "locked_until=clock_timestamp()-interval '1 second' where organization_id=%s", (tenant['org'],))
    status, _, offer = attempt(devices[2], person['code'], person['pin'])
    check(status == 200 and offer['actions'] == ['CLOCK_IN'], 'SEC-H4-01 after the server-clock expiry the correct PIN works again')
    del gw
    return {'failures_to_lock': 60, 'seconds_to_lock': round(elapsed, 1), 'buckets_per_tenant_behind_proxy': 1}


def main() -> None:
    gateway_dsn = login(suite, 'kiosk_h7_edge', 'fichaje_gateway')
    pepper, network, ingress = secret_b64(), secret_b64(), secret_b64()
    suite.remember(pepper, network, ingress)
    dist = build_dist(suite.scratch / 'dist', S['url'], S['publishable'], 'h7-edge')
    start_functions(processes, functions_env(S, gateway_dsn, pepper, network, ingress, 'h7-edge'), KIOSK_PORT, EXPORT_PORT)
    edge = start_edge(processes, suite.scratch, dist, EDGE_PORT, {'FICHAJE_KIOSK_UPSTREAM': f'http://127.0.0.1:{KIOSK_PORT}',
                                                                  'FICHAJE_EXPORT_LINK_UPSTREAM': f'http://127.0.0.1:{EXPORT_PORT}',
                                                                  'FICHAJE_INGRESS_SECRET': ingress})
    report = {}
    try:
        history_before = history_digest()
        static_policy(edge, dist)
        state = flows_through_edge(edge)
        device = {'id': state['kiosk']['device_id'], 'token': api.token(state['kiosk']['device_email'], state['kiosk']['device_password'])}
        worker = {'token': api.token(state['tenant']['worker']['email'], state['tenant']['worker']['password'])}
        gateway_contract(edge, device['token'])
        bypass(ingress, {'org': state['tenant']['org']}, device, worker)
        staging_verifier(edge, state)
        platform_mode_fails_closed(gateway_dsn)
        report['sec_h4_01'] = sec_h4_01(edge, network)
        check(history_digest() != history_before, 'H7 synthetic activity recorded (history only grows through the real RPC/gateway paths)')
    finally:
        processes.stop()
        drop_logins('kiosk_h7_edge')
    (suite.scratch / 'report.json').write_text(json.dumps(report, sort_keys=True))
    findings = leak_scan(suite, [suite.scratch / 'logs', suite.scratch / 'ops-events.jsonl', suite.scratch / 'report.json'])
    for source, rule in findings:   # file name and rule only, never the value
        print(f'LEAK_PATTERN {rule} in {Path(source).name}', file=sys.stderr)
    check(findings == [], 'KIO-07/OBS-01 no PIN, password, secret, JWT, DSN, email, code or signed URL in function/edge logs, events or reports')
    print(json.dumps({'h7_edge': 'PASS', 'checks': suite.count, **report}, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:  # print only the class and code locations, never values
        import traceback
        frames = [f'{Path(f.filename).name}:{f.lineno}' for f in traceback.extract_tb(error.__traceback__)]
        print(f'FAIL h7_edge after {suite.count} checks: {type(error).__name__} at {" > ".join(frames[-4:])}', file=sys.stderr)
        if isinstance(error, AssertionError):
            print(f'assertion: {error}', file=sys.stderr)
        sys.exit(1)

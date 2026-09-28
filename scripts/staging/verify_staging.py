"""H7 staging verification (operator-run, read-only, synthetic data only).

Checks the deployed environment from the outside, the way a browser and an
attacker see it: TLS and HSTS, static security headers and CSP, caching, no
source maps, no secret in the public bundle, the /gateway edge contract (routes,
methods, origin policy, limits, no-store, no CORS), that the functions refuse a
direct call that skips the edge, Auth settings (no public signup), private
Storage, anonymous API denial and the private schema not exposed. Optionally
runs the synthetic canary (web + kiosk through the edge) from a canary state
file. Prints only check names and PASS/FAIL/SKIPPED: never URLs, keys, tokens
or bodies. The public key is read from an environment variable name.

    python3 scripts/staging/verify_staging.py --app-url https://<staging> \
        --api-url https://<ref>.supabase.co [--canary-state <0600 file>]

--local (loopback only) skips the TLS/redirect checks so the same verifier can
run against the local staging shape in CI.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import socket
import ssl
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts' / 'ops'))
from opslib import loopback  # noqa: E402

RESULTS: dict[str, str] = {}


def record(name: str, ok: bool | None, reason: str = '') -> None:
    RESULTS[name] = 'SKIPPED' + (f' ({reason})' if reason else '') if ok is None else 'PASS' if ok else 'FAIL'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def fetch(method: str, url: str, headers: dict | None = None, body: bytes | None = None, follow: bool = True, timeout: float = 20):
    opener = urllib.request.build_opener(*(() if follow else (NoRedirect(),)))
    request = urllib.request.Request(url, data=body, method=method, headers=dict(headers or {}))
    try:
        with opener.open(request, timeout=timeout) as response:
            return response.status, {k.lower(): v for k, v in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def static_checks(app: str, api: str, local: bool) -> list[str]:
    parsed = urllib.parse.urlparse(app)
    if local:
        record('tls_https_only', None, 'local')
        record('tls_http_redirect', None, 'local')
        record('tls_version', None, 'local')
    else:
        record('tls_https_only', parsed.scheme == 'https')
        status, head, _ = fetch('GET', f'http://{parsed.netloc}/', follow=False)
        record('tls_http_redirect', status in (301, 302, 307, 308) and head.get('location', '').startswith('https://'))
        context = ssl.create_default_context()
        with socket.create_connection((parsed.hostname, parsed.port or 443), timeout=10) as raw:
            with context.wrap_socket(raw, server_hostname=parsed.hostname) as tls:
                record('tls_version', tls.version() in ('TLSv1.2', 'TLSv1.3'))
    status, head, body = fetch('GET', app + '/')
    html = body.decode('utf-8', 'replace')
    csp = head.get('content-security-policy', '')
    record('app_served', status == 200 and 'id="root"' in html)
    hsts = re.search(r'max-age=(\d+)', head.get('strict-transport-security', ''))
    record('hsts', bool(hsts) and int(hsts.group(1)) >= 31536000)
    api_origin = urllib.parse.urlparse(api)
    record('csp', all(p in csp for p in ("default-src 'self'", "script-src 'self'", "object-src 'none'", "frame-ancestors 'none'",
                                          f"connect-src 'self' {api_origin.scheme}://{api_origin.netloc}")) and '*' not in csp)
    record('security_headers', head.get('x-frame-options') == 'DENY' and head.get('x-content-type-options') == 'nosniff'
           and head.get('referrer-policy') == 'no-referrer' and 'geolocation=()' in head.get('permissions-policy', '')
           and head.get('cross-origin-opener-policy') == 'same-origin' and head.get('cross-origin-resource-policy') == 'same-origin')
    record('no_cors_static', 'access-control-allow-origin' not in head)
    record('html_revalidated', head.get('cache-control') == 'no-cache')
    assets = sorted(set(re.findall(r'(?:src|href)="(/assets/[^"]+\.(?:js|css))"', html)))
    downloaded = {'index.html': body}
    maps_ok, cache_ok = True, True
    for asset in assets:
        status, head, content = fetch('GET', app + asset)
        downloaded[asset.strip('/').replace('/', '_')] = content
        cache_ok &= status == 200 and head.get('cache-control') == 'public, max-age=31536000, immutable' and 'access-control-allow-origin' not in head
        maps_ok &= b'sourceMappingURL' not in content
        status, head, content = fetch('GET', app + asset + '.map')
        maps_ok &= not (status == 200 and head.get('content-type', '').startswith('application/json'))
    status, head, content = fetch('GET', app + '/sw.js')
    downloaded['sw.js'] = content
    record('assets_immutable', bool(assets) and cache_ok)
    record('sw_revalidated', status == 200 and head.get('cache-control') == 'no-cache')
    record('no_source_maps', maps_ok)
    with tempfile.TemporaryDirectory(prefix='staging-bundle-') as tmp:
        for name, content in downloaded.items():
            (Path(tmp) / name).write_bytes(content)
        scan = subprocess.run(['node', str(ROOT / 'scripts' / 'scan_secrets.mjs'), tmp], capture_output=True)
        record('bundle_secret_scan', scan.returncode == 0)
    return assets


def edge_checks(app: str) -> None:
    for component in ('kiosk', 'export-link'):
        status, head, body = fetch('GET', f'{app}/gateway/{component}/health/ready')
        try:
            ready = json.loads(body).get('status') == 'UP'
        except ValueError:
            ready = False
        record(f'edge_{component}_ready', status == 200 and ready and head.get('cache-control') == 'no-store, max-age=0'
               and 'access-control-allow-origin' not in head)
    json_headers = {'Content-Type': 'application/json'}
    record('edge_unknown_route', fetch('POST', app + '/gateway/kiosk/debug', json_headers, b'{}')[0] == 404)
    record('edge_method', fetch('GET', app + '/gateway/kiosk/record')[0] == 405)
    status, head, _ = fetch('OPTIONS', app + '/gateway/kiosk/authenticate', {'Origin': 'https://attacker.invalid',
                                                                            'Access-Control-Request-Method': 'POST'})
    record('edge_no_cors_preflight', status == 405 and not any(k.startswith('access-control-') for k in head))
    record('edge_cross_site', fetch('POST', app + '/gateway/kiosk/record', {**json_headers, 'Sec-Fetch-Site': 'cross-site'}, b'{}')[0] == 403)
    record('edge_foreign_origin', fetch('POST', app + '/gateway/kiosk/record', {**json_headers, 'Origin': 'https://attacker.invalid'}, b'{}')[0] == 403)
    record('edge_body_limit', fetch('POST', app + '/gateway/kiosk/record', json_headers, b'{' + b' ' * 8192 + b'}')[0] == 413)
    status, head, _ = fetch('POST', app + '/gateway/kiosk/record', json_headers, b'{}')
    record('edge_unauthenticated_refused', status == 403 and head.get('cache-control') == 'no-store, max-age=0')


def platform_checks(api: str, anon: str, kiosk_direct: str, export_direct: str) -> None:
    direct = [fetch('GET', kiosk_direct + '/health/ready')[0], fetch('POST', kiosk_direct + '/record', {'Content-Type': 'application/json'}, b'{}')[0],
              fetch('GET', export_direct + '/health/ready')[0]]
    record('no_direct_function_bypass', all(code in (401, 403) for code in direct))
    status, _, body = fetch('GET', api + '/auth/v1/settings', {'apikey': anon})
    try:
        settings = json.loads(body)
        external = settings.get('external', {})
        record('auth_signup_disabled', status == 200 and settings.get('disable_signup') is True)
        record('auth_email_only', external.get('email') is True and not any(v for k, v in external.items() if k != 'email'))
        record('auth_confirmation_required', settings.get('mailer_autoconfirm') is False)
    except ValueError:
        record('auth_signup_disabled', False)
    probe = f'verify-{secrets.token_hex(6)}@example.invalid'
    status, _, _ = fetch('POST', api + '/auth/v1/signup', {'apikey': anon, 'Content-Type': 'application/json'},
                         json.dumps({'email': probe, 'password': secrets.token_urlsafe(24)}).encode())
    record('auth_public_signup_refused', 400 <= status < 500)
    status, _, _ = fetch('GET', api + '/storage/v1/object/public/fichaje-evidence/probe.zip')
    record('storage_no_public_object', status >= 400)
    status, _, body = fetch('POST', api + '/storage/v1/object/list/fichaje-evidence', {'apikey': anon, 'Authorization': 'Bearer ' + anon,
                            'Content-Type': 'application/json'}, json.dumps({'prefix': '', 'limit': 10}).encode())
    record('storage_no_anonymous_listing', status >= 400 or body.strip() in (b'[]', b''))
    status, _, body = fetch('GET', api + '/rest/v1/organizations?select=id&limit=1', {'apikey': anon, 'Authorization': 'Bearer ' + anon})
    record('api_anonymous_denied', status == 401 and b'42501' in body)
    status, _, _ = fetch('GET', api + '/rest/v1/journal_source?select=id', {'apikey': anon, 'Accept-Profile': 'private'})
    record('api_private_schema_hidden', status in (400, 404, 406))
    status, _, _ = fetch('POST', api + '/rest/v1/rpc/ops_ingest_client_metrics', {'apikey': anon, 'Authorization': 'Bearer ' + anon,
                         'Content-Type': 'application/json'}, b'{"p_batch":[]}')
    record('api_telemetry_anonymous_denied', status in (401, 403))


def canary_check(api: str, anon: str, app: str, state_path: str | None) -> None:
    if not state_path:
        record('synthetic_canary', None, 'no canary state provided')
        return
    import canary as canary_mod
    import opslib
    if not opslib.LOG.path:   # allowlisted canary events go to stderr: stdout carries only the report
        opslib.LOG.stream = sys.stderr
    state = json.loads(Path(state_path).read_text(encoding='utf-8'))
    if not state.get('synthetic'):
        record('synthetic_canary', False)
        return
    report = canary_mod.Canary(state, canary_mod.Api(api, anon), canary_mod.Gateway(app + '/gateway/kiosk')).run()
    record('synthetic_canary', report['status'] == 'PASS')


def main() -> int:
    parser = argparse.ArgumentParser(description='H7 staging verification (statuses only)')
    parser.add_argument('--app-url', required=True)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--functions-url', help='direct functions base (default: <api>/functions/v1)')
    parser.add_argument('--kiosk-direct-url', help='direct kiosk function (default: <functions-url>/kiosk)')
    parser.add_argument('--export-link-direct-url', help='direct export-link function (default: <functions-url>/export-link)')
    parser.add_argument('--anon-key-env', default='SUPABASE_ANON_KEY')
    parser.add_argument('--canary-state')
    parser.add_argument('--local', action='store_true', help='loopback only: skip TLS and redirect checks')
    parser.add_argument('--out')
    args = parser.parse_args()
    app, api = args.app_url.rstrip('/'), args.api_url.rstrip('/')
    if args.local and not all(loopback(u) for u in (app, api, args.functions_url, args.kiosk_direct_url, args.export_link_direct_url) if u):
        print('--local only applies to loopback targets', file=sys.stderr)
        return 2
    anon = os.environ.get(args.anon_key_env, '')
    if not anon:
        print(f'{args.anon_key_env} is not set', file=sys.stderr)
        return 2
    static_checks(app, api, args.local)
    edge_checks(app)
    functions = (args.functions_url or api + '/functions/v1').rstrip('/')
    platform_checks(api, anon, (args.kiosk_direct_url or functions + '/kiosk').rstrip('/'),
                    (args.export_link_direct_url or functions + '/export-link').rstrip('/'))
    canary_check(api, anon, app, args.canary_state)
    failed = [k for k, v in RESULTS.items() if v == 'FAIL']
    skipped = [k for k, v in RESULTS.items() if v.startswith('SKIPPED')]
    status = 'FAIL' if failed or (skipped and not args.local) else 'PASS'
    report = {'status': status, 'checks': RESULTS}
    text = json.dumps(report, sort_keys=True, indent=2)
    if args.out:
        Path(args.out).write_text(text + '\n', encoding='utf-8')
    print(text)
    return 0 if status == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())

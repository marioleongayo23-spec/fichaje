"""H8 production verification wrapper.

The H7 external verifier is intentionally reused so production receives the
same edge/Auth/Storage/API checks. This wrapper adds fail-closed environment
pins and requires a synthetic canary state; it never provisions identities.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
VERIFIER = ROOT / 'scripts' / 'staging' / 'verify_staging.py'


def _origin_host(value: str) -> str | None:
    try:
        parsed = urlparse(value)
    except ValueError:
        return None
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password \
            or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        return None
    return parsed.hostname


def direct_overrides_allowed(functions_url: str | None, kiosk_url: str | None, export_url: str | None) -> bool:
    """Production direct-function probes are derived from the pinned API origin.
    Operator-supplied overrides could make the bypass test exercise another
    environment and therefore are intentionally refused."""
    return not any((functions_url, kiosk_url, export_url))


def allowed(app_url: str, api_url: str) -> bool:
    if os.environ.get('FICHAJE_ENV') != 'production':
        return False
    app_host = _origin_host(app_url)
    api_host = _origin_host(api_url)
    expected_app = os.environ.get('FICHAJE_PRODUCTION_APP_HOST', '')
    expected_api = os.environ.get('FICHAJE_PRODUCTION_API_HOST', '')
    if not app_host or not api_host or not expected_app or not expected_api:
        return False
    if app_host != expected_app or api_host != expected_api:
        return False
    # If staging pins are loaded in the same operator shell, production must
    # still be a different pair.
    if app_host == os.environ.get('FICHAJE_STAGING_APP_HOST') or api_host == os.environ.get('FICHAJE_STAGING_API_HOST'):
        return False
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description='H8 production verifier (synthetic canary only)')
    parser.add_argument('--app-url', required=True)
    parser.add_argument('--api-url', required=True)
    parser.add_argument('--canary-state', required=True)
    parser.add_argument('--functions-url')
    parser.add_argument('--kiosk-direct-url')
    parser.add_argument('--export-link-direct-url')
    parser.add_argument('--anon-key-env', default='SUPABASE_ANON_KEY')
    parser.add_argument('--out')
    args = parser.parse_args()

    if not allowed(args.app_url.rstrip('/'), args.api_url.rstrip('/')):
        print('production target is not explicitly pinned', file=sys.stderr)
        return 2
    if not direct_overrides_allowed(args.functions_url, args.kiosk_direct_url, args.export_link_direct_url):
        print('production direct-function URLs are derived from the pinned API and cannot be overridden', file=sys.stderr)
        return 2
    state = Path(args.canary_state)
    try:
        mode = state.stat().st_mode & 0o777
    except OSError:
        print('synthetic canary state is unavailable', file=sys.stderr)
        return 2
    if mode & 0o077:
        print('synthetic canary state must be owner-only', file=sys.stderr)
        return 2

    command = [
        sys.executable, str(VERIFIER),
        '--app-url', args.app_url,
        '--api-url', args.api_url,
        '--canary-state', str(state),
        '--anon-key-env', args.anon_key_env,
    ]
    if args.out:
        command += ['--out', args.out]
    result = subprocess.run(command, check=False)
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())

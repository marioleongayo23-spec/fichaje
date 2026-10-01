"""RES-02 release health gate with automatic rollback.

candidate → deploy → health → synthetic tests → canary → gate
  PASS: promote (the candidate becomes the last healthy release)
  FAIL: stop promotion, alert, redeploy the last healthy release, re-run
        health + canary; CRITICAL if no healthy release can be restored.

LocalDeployer reproduces the production shape on loopback for CI and drills:
static build served same-origin with the kiosk gateway and export-link signer
behind /gateway/*, each release an immutable directory (dist + functions +
release.json). H7 replaces only the deployer (Cloudflare Pages / Supabase
Edge versions); the gate, alerts and rollback logic are the same code.
Database migrations are forward-only: a release must stay compatible with the
schema (expand/contract) because rollback redeploys code, never data.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import LOG, ROOT, HttpError, OpsError, Timer, http_json, http_raw, loopback, now_iso, write_private  # noqa: E402
import health  # noqa: E402

RELEASE_RE = re.compile(r'^[0-9A-Za-z.+_-]{1,64}$')


class LocalDeployer:
    def __init__(self, workdir: Path, runtime_env: dict, build_env: dict, ports: dict, source: Path = ROOT):
        if not all(loopback(v) for k, v in runtime_env.items() if k.endswith('_URL') and '://' in v):
            raise OpsError('CONFIG', 'deployer')
        self.workdir, self.env, self.build_env, self.ports, self.source = Path(workdir), runtime_env, build_env, ports, Path(source)
        (self.workdir / 'releases').mkdir(parents=True, exist_ok=True)
        (self.workdir / 'logs').mkdir(parents=True, exist_ok=True)
        self.processes: list[subprocess.Popen] = []

    @property
    def app_url(self) -> str:
        return f'http://127.0.0.1:{self.ports["app"]}'

    def path(self, release_id: str) -> Path:
        if not RELEASE_RE.match(release_id):
            raise OpsError('INVALID_INPUT', 'release')
        return self.workdir / 'releases' / release_id

    def state(self) -> dict:
        file = self.workdir / 'release-state.json'
        return json.loads(file.read_text(encoding='utf-8')) if file.exists() else {'current': None, 'healthy': []}

    def save(self, state: dict) -> None:
        write_private(self.workdir / 'release-state.json', json.dumps(state, sort_keys=True))

    def build(self, release_id: str, commit: str) -> Path:
        timer = Timer()
        target = self.path(release_id)
        if target.exists():
            raise OpsError('INVALID_INPUT', 'release')   # releases are immutable
        env = {**os.environ, **self.build_env, 'FICHAJE_RELEASE': release_id}
        subprocess.run(['npm', 'run', 'build', '--', '--outDir', str(target / 'dist'), '--emptyOutDir'], cwd=self.source, env=env,
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.copytree(self.source / 'supabase' / 'functions', target / 'functions',
                        ignore=shutil.ignore_patterns('*_test.ts', 'deno.lock'))
        self.package(target)
        files = sorted(p for p in target.rglob('*') if p.is_file())
        manifest = {'release_id': release_id, 'commit': commit, 'built_at': now_iso(),
                    'files': {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
        (target / 'release.json').write_text(json.dumps(manifest, sort_keys=True, indent=1), encoding='utf-8')
        LOG.emit('release-gate', 'release.build', 'success', release_id=release_id, duration_ms=timer.ms)
        return target

    def package(self, target: Path) -> None:
        """Extra immutable release content (H7 edge deployers add the Pages Function)."""

    def stop(self) -> None:
        for process in self.processes:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                continue
        for process in self.processes:
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
        self.processes = []

    def _spawn(self, release_id: str, name: str, command: list[str], env: dict, cwd: Path | None = None) -> None:
        log = open(self.workdir / 'logs' / f'{release_id}-{name}.log', 'ab')
        self.processes.append(subprocess.Popen(command, cwd=cwd or self.source, env=env, stdout=log, stderr=log, start_new_session=True))

    def deploy(self, release_id: str) -> dict:
        """Stops the running release and starts `release_id`. Returns liveness."""
        timer = Timer()
        target = self.path(release_id)
        manifest = json.loads((target / 'release.json').read_text(encoding='utf-8'))
        self.stop()
        common = {**os.environ, **self.env, 'FICHAJE_RELEASE': release_id, 'FICHAJE_COMMIT': manifest['commit']}
        functions = target / 'functions'
        self._spawn(release_id, 'kiosk', ['deno', 'run', '--allow-env', '--allow-net', '--config', str(functions / 'kiosk' / 'deno.json'),
                                          str(functions / 'kiosk' / 'index.ts')], {**common, 'KIOSK_PORT': str(self.ports['kiosk'])})
        self._spawn(release_id, 'export-link', ['deno', 'run', '--allow-env', '--allow-net', str(functions / 'export-link' / 'index.ts')],
                    {**common, 'EXPORT_LINK_PORT': str(self.ports['export_link'])})
        self._spawn(release_id, 'app', ['npx', 'vite', 'preview', '--outDir', str(target / 'dist'), '--host', '127.0.0.1',
                                        '--port', str(self.ports['app']), '--strictPort'],
                    {**common, 'FICHAJE_KIOSK_GATEWAY_TARGET': f'http://127.0.0.1:{self.ports["kiosk"]}',
                     'FICHAJE_EXPORT_LINK_TARGET': f'http://127.0.0.1:{self.ports["export_link"]}'})
        live = self.wait_live()
        state = self.state()
        state['current'] = release_id
        self.save(state)
        LOG.emit('release-gate', 'release.deploy', 'success' if all(live.values()) else 'failure', release_id=release_id,
                 state='UP' if all(live.values()) else 'DOWN', duration_ms=timer.ms)
        return live

    def wait_live(self, timeout_s: float = 90) -> dict:
        urls = {'app': self.app_url + '/', 'kiosk': f'http://127.0.0.1:{self.ports["kiosk"]}/health/live',
                'export_link': f'http://127.0.0.1:{self.ports["export_link"]}/health/live'}
        live = {name: False for name in urls}
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline and not all(live.values()):
            for name, url in urls.items():
                if not live[name]:
                    try:
                        live[name] = http_raw('GET', url, {}, 2)[0] == 200
                    except (HttpError, OSError, OpsError):
                        pass
            if any(p.poll() is not None for p in self.processes) or all(live.values()):
                break
            time.sleep(0.25)
        return live

    def mark_healthy(self, release_id: str) -> None:
        state = self.state()
        state['healthy'] = [r for r in state['healthy'] if r != release_id] + [release_id]
        self.save(state)


def smoke(app_url: str, release_id: str) -> dict:
    """Synthetic contract tests of the deployed artifact (no data, no identity)."""
    checks = {}
    try:
        _, raw, _ = http_raw('GET', app_url + '/', {'Accept': 'text/html'}, 5)
        html = raw.decode('utf-8', 'replace')
        entry = re.search(r'src="(/assets/index-[^"]+\.js)"', html)
        # The release id lives only in the served index.html; the bundle it references must be real JS.
        served = re.search(r'<meta name="fichaje-release" content="([^"]*)"', html)
        checks['artifact_identity'] = bool(entry and served) and served.group(1) == release_id \
            and bool(health.fetch_asset(app_url + entry.group(1), 5))
    except (HttpError, OSError, OpsError):
        checks['artifact_identity'] = False
    try:
        checks['service_worker'] = b'__FICHAJE_PRECACHE__' not in health.fetch_asset(app_url + '/sw.js', 5)
    except (HttpError, OSError, OpsError):
        checks['service_worker'] = False
    for name, path, expected in (('kiosk_contract', '/gateway/kiosk/record', 'AUTH_FAILED'), ('export_link_contract', '/gateway/export-link', 'FORBIDDEN')):
        try:
            http_json('POST', app_url + path, {}, b'{}', 10)
            checks[name] = False          # an unauthenticated call must never succeed
        except HttpError as error:
            checks[name] = error.status == 403
        except (OSError, OpsError):
            checks[name] = False
    return {'status': 'PASS' if all(checks.values()) else 'FAIL', 'checks': checks}


def gate(release_id: str, targets: health.Targets, canary, app_url: str) -> dict:
    timer = Timer()
    report_health = health.run(targets)
    synthetic = smoke(app_url, release_id)
    report_canary = canary.run() if canary is not None else {'status': 'FAIL', 'channels': {}}
    passed = report_health['status'] == 'UP' and synthetic['status'] == 'PASS' and report_canary['status'] == 'PASS'
    LOG.emit('release-gate', 'release.gate', 'success' if passed else 'failure', release_id=release_id,
             state='PASS' if passed else 'FAIL', error_class='NONE' if passed else 'DEGRADED', duration_ms=timer.ms)
    return {'release_id': release_id, 'status': 'PASS' if passed else 'FAIL', 'health': report_health,
            'synthetic': synthetic, 'canary': report_canary}


def promote(deployer: LocalDeployer, candidate: str, gate_fn, engine) -> dict:
    """Deploy, gate, and either promote or roll back to the last healthy release."""
    state = deployer.state()
    previous = state['current'] if state.get('current') in state.get('healthy', []) else (state['healthy'][-1] if state.get('healthy') else None)
    deployer.deploy(candidate)
    first = gate_fn(candidate)
    signals = {'health': first['health'], 'canary': first['canary']}
    if first['status'] == 'PASS':
        deployer.mark_healthy(candidate)
        notifications = engine.process({**signals, 'release': {'state': 'HEALTHY'}})
        LOG.emit('release-gate', 'release.promote', 'success', release_id=candidate, state='PROMOTED')
        return {'state': 'PROMOTED', 'current': candidate, 'gates': [first], 'notifications': notifications}
    notifications = engine.process({**signals, 'release': {'state': 'DEGRADED'}})
    LOG.emit('release-gate', 'release.promote', 'rejected', release_id=candidate, state='FAIL', error_class='DEGRADED')
    if previous is None or previous == candidate:
        notifications += engine.process({'release': {'state': 'NO_ROLLBACK'}})
        return {'state': 'NO_ROLLBACK', 'current': candidate, 'gates': [first], 'notifications': notifications}
    timer = Timer()
    deployer.deploy(previous)
    second = gate_fn(previous)
    if second['status'] == 'PASS':
        notifications += engine.process({'health': second['health'], 'canary': second['canary'], 'release': {'state': 'HEALTHY'}})
        LOG.emit('release-gate', 'release.rollback', 'success', release_id=previous, state='ROLLED_BACK', duration_ms=timer.ms)
        return {'state': 'ROLLED_BACK', 'current': previous, 'gates': [first, second], 'notifications': notifications}
    notifications += engine.process({'health': second['health'], 'canary': second['canary'], 'release': {'state': 'NO_ROLLBACK'}})
    LOG.emit('release-gate', 'release.rollback', 'failure', release_id=previous, state='NO_ROLLBACK', error_class='DEGRADED', duration_ms=timer.ms)
    return {'state': 'NO_ROLLBACK', 'current': previous, 'gates': [first, second], 'notifications': notifications}

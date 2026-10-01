"""H7 deployers for the RES-02 release gate (release_gate.promote()).

EdgeLocalDeployer: the staging shape on loopback for drills and CI. Each
immutable release holds dist (with _headers and _routes.json), the Cloudflare
Pages Function and the Deno functions. workerd (the pinned wrangler of edge/)
serves the release in front of the functions, which only accept edge-signed
requests. The ingress secret is runtime configuration in a 0600 file outside
the release, never part of the artifact.

PlatformDeployer: the real staging/production adapter (Cloudflare Pages Direct
Upload + Supabase Edge Functions). It is run by the operator from a trusted
machine: credentials are read from the operator's environment (filled from
their secret custody), passed only to the platform CLIs and never written,
logged or stored in GitHub. Rollback redeploys the previous healthy immutable
release through the same path. Database migrations are forward-only
(expand/contract): a rollback redeploys code, never data.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import LOG, ROOT, HttpError, OpsError, Timer, http_raw, loopback, now_iso, write_private  # noqa: E402
from release_gate import RELEASE_RE, LocalDeployer  # noqa: E402

COMPATIBILITY_DATE = '2026-09-01'
WRANGLER_ENV = {'WRANGLER_SEND_METRICS': 'false', 'CLOUDFLARE_CF_FETCH_ENABLED': 'false', 'CI': '1', 'NO_COLOR': '1'}


LIVENESS = {'app': '/', 'kiosk': '/gateway/kiosk/health/live', 'export_link': '/gateway/export-link/health/live'}


def answered(app_url: str, name: str, timeout: float) -> bool:
    """Liveness = the component answers through the edge. For the functions a
    403 is an answer too (up but refusing): correctness is the gate's job, so a
    defective release reaches the gate at once instead of waiting a timeout."""
    try:
        status = http_raw('GET', app_url + LIVENESS[name], {}, timeout)[0]
    except HttpError as error:
        status = error.status
    except (OSError, OpsError):
        return False
    return status == 200 or (name != 'app' and status == 403)


def package_pages(source: Path, target: Path) -> None:
    """Pages Function sources with the relative layout their imports expect."""
    pages = target / 'pages'
    shutil.copytree(source / 'functions', pages / 'functions')
    (pages / 'edge').mkdir(parents=True)
    shutil.copy2(source / 'edge' / 'gateway.ts', pages / 'edge' / 'gateway.ts')
    shared = pages / 'supabase' / 'functions' / '_shared'
    shared.mkdir(parents=True)
    shutil.copy2(source / 'supabase' / 'functions' / '_shared' / 'ingress.ts', shared / 'ingress.ts')


class EdgeLocalDeployer(LocalDeployer):
    def __init__(self, workdir: Path, runtime_env: dict, build_env: dict, ports: dict, ingress_secret: str, wrangler: Path,
                 source: Path = ROOT):
        super().__init__(workdir, runtime_env, build_env, ports, source)
        self.ingress = ingress_secret
        self.wrangler = Path(wrangler)

    def package(self, target: Path) -> None:
        package_pages(self.source, target)

    def deploy(self, release_id: str) -> dict:
        timer = Timer()
        target = self.path(release_id)
        manifest = json.loads((target / 'release.json').read_text(encoding='utf-8'))
        self.stop()
        common = {**os.environ, **self.env, 'FICHAJE_RELEASE': release_id, 'FICHAJE_COMMIT': manifest['commit'],
                  'FICHAJE_INGRESS_SECRET': self.ingress}
        functions = target / 'functions'
        self._spawn(release_id, 'kiosk', ['deno', 'run', '--allow-env', '--allow-net', '--config', str(functions / 'kiosk' / 'deno.json'),
                                          str(functions / 'kiosk' / 'index.ts')], {**common, 'KIOSK_PORT': str(self.ports['kiosk'])})
        self._spawn(release_id, 'export-link', ['deno', 'run', '--allow-env', '--allow-net', str(functions / 'export-link' / 'index.ts')],
                    {**common, 'EXPORT_LINK_PORT': str(self.ports['export_link'])})
        runtime = self.workdir / 'runtime' / release_id
        if runtime.exists():
            shutil.rmtree(runtime)
        runtime.mkdir(parents=True)
        os.chmod(runtime, 0o700)
        os.symlink(target / 'pages' / 'functions', runtime / 'functions')
        write_private(runtime / '.dev.vars', ''.join(f'{k}="{v}"\n' for k, v in {
            'FICHAJE_KIOSK_UPSTREAM': f'http://127.0.0.1:{self.ports["kiosk"]}',
            'FICHAJE_EXPORT_LINK_UPSTREAM': f'http://127.0.0.1:{self.ports["export_link"]}',
            'FICHAJE_INGRESS_SECRET': self.ingress}.items()))
        self._spawn(release_id, 'edge', [str(self.wrangler), 'pages', 'dev', str(target / 'dist'), '--ip', '127.0.0.1',
                                         '--port', str(self.ports['app']), '--compatibility-date', COMPATIBILITY_DATE, '--log-level', 'warn'],
                    {**os.environ, **WRANGLER_ENV}, cwd=runtime)
        live = self.wait_live()
        state = self.state()
        state['current'] = release_id
        self.save(state)
        LOG.emit('release-gate', 'release.deploy', 'success' if all(live.values()) else 'failure', release_id=release_id,
                 state='UP' if all(live.values()) else 'DOWN', duration_ms=timer.ms)
        return live

    def wait_live(self, timeout_s: float = 120) -> dict:
        """Liveness through the edge only (the functions refuse direct probes)."""
        live = {name: False for name in LIVENESS}
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline and not all(live.values()):
            for name in LIVENESS:
                live[name] = live[name] or answered(self.app_url, name, 3)
            if any(p.poll() is not None for p in self.processes) or all(live.values()):
                break
            time.sleep(0.25)
        return live


class PlatformDeployer:
    """Cloudflare Pages (Direct Upload) + Supabase Edge Functions, operator-run."""

    CREDENTIALS = ('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'SUPABASE_ACCESS_TOKEN')
    FUNCTIONS = ('kiosk', 'export-link')

    def __init__(self, workdir: Path, environment: str, pages_project: str, supabase_ref: str, app_url: str, build_env: dict,
                 source: Path = ROOT, wrangler: str = 'wrangler', supabase: str = 'supabase', runner=subprocess.run):
        if environment not in ('staging', 'production') or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,57}', pages_project) \
                or not re.fullmatch(r'[a-z]{20}', supabase_ref) or not re.fullmatch(r'https://[a-z0-9.-]+(:\d+)?', app_url.rstrip('/')):
            raise OpsError('CONFIG', 'deployer')
        if any(not os.environ.get(name) for name in self.CREDENTIALS):
            raise OpsError('CONFIG', 'deployer')          # operator secret custody not loaded: nothing is attempted
        if not {'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'} <= set(build_env) or loopback(build_env['VITE_SUPABASE_URL']):
            raise OpsError('CONFIG', 'deployer')
        self.workdir, self.environment, self.project, self.ref = Path(workdir), environment, pages_project, supabase_ref
        self.app_url, self.build_env, self.source = app_url.rstrip('/'), build_env, Path(source)
        self.wrangler, self.supabase, self.runner = wrangler, supabase, runner
        (self.workdir / 'releases').mkdir(parents=True, exist_ok=True)
        (self.workdir / 'logs').mkdir(parents=True, exist_ok=True)
        os.chmod(self.workdir, 0o700)

    # -- same state contract as LocalDeployer -----------------------------------
    def path(self, release_id: str) -> Path:
        if not RELEASE_RE.match(release_id):
            raise OpsError('INVALID_INPUT', 'release')
        return self.workdir / 'releases' / release_id

    def state(self) -> dict:
        file = self.workdir / 'release-state.json'
        return json.loads(file.read_text(encoding='utf-8')) if file.exists() else {'current': None, 'healthy': []}

    def save(self, state: dict) -> None:
        write_private(self.workdir / 'release-state.json', json.dumps(state, sort_keys=True))

    def mark_healthy(self, release_id: str) -> None:
        state = self.state()
        state['healthy'] = [r for r in state['healthy'] if r != release_id] + [release_id]
        self.save(state)

    def _run(self, release_id: str, step: str, command: list[str], cwd: Path, env: dict) -> None:
        """Platform CLI call; output goes only to a private log; failures raise a stable class."""
        log = self.workdir / 'logs' / f'{release_id}-{step}.log'
        with open(log, 'ab') as handle:
            os.chmod(log, 0o600)
            result = self.runner(command, cwd=cwd, env=env, stdout=handle, stderr=handle, check=False)
        if result.returncode != 0:
            raise OpsError('UPSTREAM_5XX', step)

    def _env(self, *names: str) -> dict:
        base = {k: os.environ[k] for k in ('PATH', 'HOME', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS') if k in os.environ}
        return {**base, **{n: os.environ[n] for n in names}}

    def build(self, release_id: str, commit: str) -> Path:
        timer = Timer()
        target = self.path(release_id)
        if target.exists():
            raise OpsError('INVALID_INPUT', 'release')
        if not re.fullmatch(r'[0-9a-f]{40}', commit):
            raise OpsError('INVALID_INPUT', 'release')
        env = {**self._env(), **self.build_env, 'FICHAJE_RELEASE': release_id}
        self._run(release_id, 'build', ['npm', 'run', 'build', '--', '--outDir', str(target / 'dist'), '--emptyOutDir'], self.source, env)
        package_pages(self.source, target)
        shutil.copytree(self.source / 'supabase' / 'functions', target / 'supabase' / 'functions',
                        ignore=shutil.ignore_patterns('*_test.ts', 'deno.lock'))
        shutil.copy2(self.source / 'supabase' / 'config.toml', target / 'supabase' / 'config.toml')
        files = sorted(p for p in target.rglob('*') if p.is_file())
        manifest = {'release_id': release_id, 'commit': commit, 'environment': self.environment, 'built_at': now_iso(),
                    'files': {str(p.relative_to(target)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
        (target / 'release.json').write_text(json.dumps(manifest, sort_keys=True, indent=1), encoding='utf-8')
        LOG.emit('release-gate', 'release.build', 'success', release_id=release_id, environment=self.environment, duration_ms=timer.ms)
        return target

    def deploy(self, release_id: str) -> dict:
        timer = Timer()
        target = self.path(release_id)
        manifest = json.loads((target / 'release.json').read_text(encoding='utf-8'))
        supabase_env = self._env('SUPABASE_ACCESS_TOKEN')
        try:
            # Release identity only (public metadata); real secrets are set once by the operator.
            self._run(release_id, 'identity', [self.supabase, 'secrets', 'set', '--project-ref', self.ref,
                                               f'FICHAJE_RELEASE={release_id}', f'FICHAJE_COMMIT={manifest["commit"]}'], target, supabase_env)
            for function in self.FUNCTIONS:
                self._run(release_id, f'functions-{function}', [self.supabase, 'functions', 'deploy', function, '--project-ref', self.ref,
                                                                '--no-verify-jwt', '--use-api', '--workdir', str(target)], target, supabase_env)
            self._run(release_id, 'pages', [self.wrangler, 'pages', 'deploy', str(target / 'dist'), '--project-name', self.project,
                                            '--branch', 'main' if self.environment == 'production' else 'staging',
                                            '--commit-hash', manifest['commit'], '--commit-message', f'release {release_id}', '--commit-dirty=false'],
                      target / 'pages', {**self._env('CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'), **WRANGLER_ENV})
        except OpsError as error:
            LOG.emit('release-gate', 'release.deploy', 'failure', release_id=release_id, environment=self.environment,
                     error_class=error.error_class, duration_ms=timer.ms)
            return {'app': False, 'kiosk': False, 'export_link': False}
        live = self.wait_live()
        state = self.state()
        state['current'] = release_id
        self.save(state)
        LOG.emit('release-gate', 'release.deploy', 'success' if all(live.values()) else 'failure', release_id=release_id,
                 environment=self.environment, state='UP' if all(live.values()) else 'DOWN', duration_ms=timer.ms)
        return live

    def wait_live(self, timeout_s: float = 180) -> dict:
        live = {name: False for name in LIVENESS}
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline and not all(live.values()):
            for name in LIVENESS:
                live[name] = live[name] or answered(self.app_url, name, 5)
            if not all(live.values()):
                time.sleep(2)
        return live

    def stop(self) -> None:
        """Nothing local to stop: the platform keeps serving the current release."""

"""RES-04 backup monitoring. Watches, never enables.

Repository backup (existing OPS-01 workflow): expected workflow, latest run,
conclusion, artifact present and not expired, SHA256SUMS, `git bundle verify`
and a restore rehearsal of the bundle (mirror clone + fsck + refs + manifest
commit), and freshness. "Upload succeeded" is never accepted as "restorable".

PostgreSQL backup: still blocked until H7 (scripts/backup_database.sh exits 2
unconditionally). Its monitor contract is implemented (evaluate_db_manifest)
but the live status is NOT_CONFIGURED and is never reported as green.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import CONTRACT, LOG, ROOT, HttpError, OpsError, Timer, http_json, now_iso  # noqa: E402
from retry import Operation, RetryPolicy, execute  # noqa: E402

REQUIRED_FILES = ('repository.bundle', 'snapshot.tar.gz', 'manifest.txt', 'refs.txt', 'SHA256SUMS')


def _time(value: str) -> datetime:
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


class GitHub:
    def __init__(self, api_url: str, repo: str, token: str | None, timeout: float = 20.0):
        self.api, self.repo, self.token, self.timeout = api_url.rstrip('/'), repo, token, timeout

    def headers(self) -> dict:
        headers = {'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'fichaje-ops-backup-monitor'}
        if self.token:
            headers['Authorization'] = 'Bearer ' + self.token
        return headers

    def _get(self, path: str):
        op = Operation('backup-monitor', 'backup.repo', idempotent=True, mutation=False)
        return execute(op, lambda _p, _n: http_json('GET', self.api + path, self.headers(), None, self.timeout)[1],
                       RetryPolicy(max_attempts=3, base_delay_ms=500, max_delay_ms=2000))

    def runs(self, workflow: str, branch: str = 'main') -> list[dict]:
        data = self._get(f'/repos/{self.repo}/actions/workflows/{workflow}/runs?branch={branch}&per_page=20')
        return data.get('workflow_runs', []) if isinstance(data, dict) else []

    def artifacts(self, run_id: int) -> list[dict]:
        data = self._get(f'/repos/{self.repo}/actions/runs/{run_id}/artifacts')
        return data.get('artifacts', []) if isinstance(data, dict) else []

    def download(self, artifact_id: int) -> bytes:
        request = urllib.request.Request(f'{self.api}/repos/{self.repo}/actions/artifacts/{artifact_id}/zip')
        for key, value in self.headers().items():
            # The token is never forwarded to the storage host GitHub redirects to.
            (request.add_unredirected_header if key == 'Authorization' else request.add_header)(key, value)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise HttpError(error.code, 'STORAGE_ERROR') from None


def verify_artifact(archive: bytes) -> dict:
    """Checksums, bundle integrity and a restore rehearsal in a temporary directory."""
    with tempfile.TemporaryDirectory(prefix='ops-backup-verify-') as tmp:
        root = Path(tmp)
        with zipfile.ZipFile(io.BytesIO(archive)) as bundle_zip:
            for member in bundle_zip.namelist():
                target = (root / 'artifact' / member).resolve()
                if not str(target).startswith(str((root / 'artifact').resolve())):
                    return {'verified': False, 'error_class': 'INVALID_RESPONSE', 'restore_tested': False}
            bundle_zip.extractall(root / 'artifact')
        sums = list((root / 'artifact').rglob('SHA256SUMS'))
        if len(sums) != 1:
            return {'verified': False, 'error_class': 'ASSERTION', 'restore_tested': False, 'reason': 'MISSING_CHECKSUMS'}
        folder = sums[0].parent
        if any(not (folder / name).is_file() for name in REQUIRED_FILES):
            return {'verified': False, 'error_class': 'ASSERTION', 'restore_tested': False, 'reason': 'MISSING_FILES'}
        checked = subprocess.run(['sha256sum', '-c', '--strict', 'SHA256SUMS'], cwd=folder, capture_output=True)
        listed = {line.split()[-1] for line in (folder / 'SHA256SUMS').read_text().splitlines() if line.strip()}
        if checked.returncode != 0 or not {'repository.bundle', 'snapshot.tar.gz', 'manifest.txt', 'refs.txt'} <= listed:
            return {'verified': False, 'error_class': 'ASSERTION', 'restore_tested': False, 'reason': 'CHECKSUM_MISMATCH'}
        git = lambda *a: subprocess.run(['git', *a], capture_output=True, text=True)  # noqa: E731
        scratch = root / 'verify'
        git('init', '-q', str(scratch))
        if git('-C', str(scratch), 'bundle', 'verify', str(folder / 'repository.bundle')).returncode != 0:
            return {'verified': False, 'error_class': 'ASSERTION', 'restore_tested': False, 'reason': 'BUNDLE_INVALID'}
        restored = root / 'restored.git'
        if git('clone', '-q', '--mirror', str(folder / 'repository.bundle'), str(restored)).returncode != 0 \
                or git('--git-dir', str(restored), 'fsck', '--full').returncode != 0:
            return {'verified': True, 'error_class': 'ASSERTION', 'restore_tested': False, 'reason': 'RESTORE_FAILED'}
        refs = git('--git-dir', str(restored), 'for-each-ref', '--format=%(objectname) %(refname)').stdout
        manifest = dict(line.split('=', 1) for line in (folder / 'manifest.txt').read_text().splitlines() if '=' in line)
        commit = manifest.get('commit', '')
        has_commit = git('--git-dir', str(restored), 'cat-file', '-e', commit + '^{commit}').returncode == 0 if commit else False
        if refs != (folder / 'refs.txt').read_text() or not has_commit:
            return {'verified': True, 'error_class': 'ASSERTION', 'restore_tested': False, 'reason': 'REFS_MISMATCH'}
        return {'verified': True, 'error_class': 'NONE', 'restore_tested': True, 'commit': commit}


def evaluate_repo(runs: list[dict], artifacts: list[dict] | None, verification: dict | None, now: datetime,
                  max_age_hours: float | None = None) -> dict:
    max_age = timedelta(hours=max_age_hours if max_age_hours is not None else CONTRACT['thresholds']['backup_max_age_hours'])
    completed = sorted([r for r in runs if r.get('status') == 'completed'], key=lambda r: r['updated_at'], reverse=True)
    if not completed:
        return {'status': 'MISSING', 'age_seconds': None, 'reason': 'NO_COMPLETED_RUN'}
    latest = completed[0]
    base = {'run_id': latest['id'], 'conclusion': latest.get('conclusion')}
    if latest.get('conclusion') != 'success':
        return {**base, 'status': 'FAILED', 'age_seconds': None, 'reason': 'LATEST_RUN_NOT_SUCCESSFUL'}
    age = (now - _time(latest['updated_at'])).total_seconds()
    base['age_seconds'] = round(age)
    if age > max_age.total_seconds():
        return {**base, 'status': 'STALE', 'reason': 'OLDER_THAN_THRESHOLD'}
    usable = [a for a in (artifacts or []) if str(a.get('name', '')).startswith('repository-') and not a.get('expired')
              and int(a.get('size_in_bytes', 0)) > 0]
    if not usable:
        return {**base, 'status': 'MISSING', 'reason': 'ARTIFACT_MISSING'}
    if not verification or not verification.get('verified') or not verification.get('restore_tested'):
        return {**base, 'status': 'UNVERIFIED', 'reason': (verification or {}).get('reason', 'NOT_VERIFIED'),
                'verified': bool((verification or {}).get('verified')), 'restore_tested': False}
    return {**base, 'status': 'OK', 'verified': True, 'restore_tested': True, 'artifact_digest': usable[0].get('digest')}


def evaluate_db_manifest(manifest: dict | None, now: datetime, max_age_hours: float | None = None) -> dict:
    """Contract for the future encrypted PostgreSQL backup (H7). Green only for a
    fresh, encrypted, checksummed backup whose isolated restore test passed."""
    if manifest is None:
        return {'status': 'NOT_CONFIGURED', 'age_seconds': None, 'reason': 'DATABASE_BACKUP_BLOCKED_UNTIL_H7'}
    max_age = timedelta(hours=max_age_hours if max_age_hours is not None else CONTRACT['thresholds']['backup_max_age_hours'])
    if manifest.get('result') != 'success':
        return {'status': 'FAILED', 'age_seconds': None, 'reason': 'LATEST_BACKUP_FAILED'}
    age = (now - _time(manifest['completed_at'])).total_seconds()
    if age > max_age.total_seconds():
        return {'status': 'STALE', 'age_seconds': round(age), 'reason': 'OLDER_THAN_THRESHOLD'}
    if not manifest.get('encrypted') or not manifest.get('ciphertext_sha256'):
        return {'status': 'UNVERIFIED', 'age_seconds': round(age), 'reason': 'NOT_ENCRYPTED_OR_NO_CHECKSUM'}
    restore = manifest.get('restore_test') or {}
    if restore.get('result') != 'success' or _time(restore['completed_at']) < _time(manifest['completed_at']):
        return {'status': 'UNVERIFIED', 'age_seconds': round(age), 'reason': 'RESTORE_NOT_TESTED'}
    return {'status': 'OK', 'age_seconds': round(age), 'verified': True, 'restore_tested': True}


def database_backup_blocked() -> bool:
    """The hard gate of H0 must still be in place while the DB monitor is NOT_CONFIGURED."""
    result = subprocess.run(['bash', str(ROOT / 'scripts' / 'backup_database.sh')], capture_output=True,
                            env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
    return result.returncode == 2


def monitor(github: GitHub | None, workflow: str = 'backup.yml', verify: bool = True, now: datetime | None = None,
            db_manifest: dict | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    timer = Timer()
    report: dict = {}
    try:
        runs = github.runs(workflow) if github else []
        latest_success = next((r for r in sorted(runs, key=lambda r: r['updated_at'], reverse=True)
                               if r.get('status') == 'completed' and r.get('conclusion') == 'success'), None)
        artifacts = github.artifacts(latest_success['id']) if github and latest_success else []
        verification = None
        usable = [a for a in artifacts if str(a.get('name', '')).startswith('repository-') and not a.get('expired')]
        if verify and usable and github and github.token:
            verification = verify_artifact(github.download(usable[0]['id']))
        report['repo'] = evaluate_repo(runs, artifacts, verification, now)
    except OpsError as error:
        report['repo'] = {'status': 'UNVERIFIED', 'age_seconds': None, 'reason': 'MONITOR_UNAVAILABLE', 'error_class': error.error_class}
    database = evaluate_db_manifest(db_manifest, now)
    if database['status'] == 'NOT_CONFIGURED' and not database_backup_blocked():
        # An enabled script without the monitored contract is never trusted.
        database = {'status': 'UNVERIFIED', 'age_seconds': None, 'reason': 'ENABLED_WITHOUT_MONITOR_CONTRACT'}
    report['database'] = database
    for kind, result in report.items():
        LOG.emit('backup-monitor', f'backup.{kind}', 'success' if result['status'] == 'OK' else 'failure', kind=kind,
                 state=result['status'], error_class='NONE' if result['status'] == 'OK' else 'CONFIG' if result['status'] == 'NOT_CONFIGURED' else 'ASSERTION',
                 duration_ms=timer.ms)
    report['generated_at'] = now_iso()
    return report


def markdown(report: dict) -> str:
    """Job summary: kind, status, reason, age and verification flags only."""
    lines = ['## OPS-02 backup monitor', '', '| kind | status | reason | age (h) | verified | restore tested |', '|---|---|---|---|---|---|']
    for kind in ('repo', 'database'):
        item = report[kind]
        age = item.get('age_seconds')
        lines.append(f"| {kind} | {item['status']} | {item.get('reason', '')} | {'' if age is None else round(age / 3600, 1)} "
                     f"| {bool(item.get('verified'))} | {bool(item.get('restore_tested'))} |")
    return '\n'.join(lines) + '\n\nUna subida correcta no equivale a un backup restaurable; PostgreSQL sigue NOT_CONFIGURED hasta H7.\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='OPS-02 backup monitor (token only via environment variable name)')
    parser.add_argument('--api', default='https://api.github.com')
    parser.add_argument('--repo', required=True)
    parser.add_argument('--workflow', default='backup.yml')
    parser.add_argument('--token-env', default='GITHUB_TOKEN')
    parser.add_argument('--no-verify', action='store_true')
    parser.add_argument('--out')
    parser.add_argument('--summary', help='append a Markdown status table (statuses only) to this file')
    args = parser.parse_args()
    result = monitor(GitHub(args.api, args.repo, os.environ.get(args.token_env)), args.workflow, not args.no_verify)
    text = json.dumps(result, indent=2, sort_keys=True)
    if args.out:
        Path(args.out).write_text(text + '\n', encoding='utf-8')
    if args.summary:
        with open(args.summary, 'a', encoding='utf-8') as summary:
            summary.write(markdown(result))
    print(text)
    critical = {'STALE', 'FAILED', 'MISSING', 'UNVERIFIED'}
    sys.exit(2 if result['repo']['status'] in critical or result['database']['status'] in critical else 0)

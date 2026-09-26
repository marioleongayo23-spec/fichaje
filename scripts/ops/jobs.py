"""OPS-02 job runner (OBS-02 JOBS, RES-01) and recovery-journal monitor.

Jobs are retried only because each one is idempotent by construction: the
export worker publishes READY only after a verified upload of a fixed object
path, purge_operational removes expired operational rows (never labour data)
and journal reconciliation only appends COMMITTED/ABORTED for finished
transactions. Nothing is retried with different input.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from opslib import CONTRACT, ERROR_CLASSES, LOG, OpsError, Timer, classify_exception  # noqa: E402
from retry import Operation, RetryPolicy, execute, NotRetryable, RetryExhausted  # noqa: E402


def classify_job_error(error: BaseException) -> str:
    message = str(error)
    if isinstance(error, RuntimeError) and message in ERROR_CLASSES:
        return message
    if isinstance(error, urllib.error.HTTPError):
        return 'STORAGE_ERROR' if error.code < 500 else 'UPSTREAM_5XX'
    return classify_exception(error)


def run_job(job: str, work, policy: RetryPolicy | None = None, sleep=None) -> dict:
    """Runs an idempotent job with bounded retries; returns a signal for alerts."""
    if job not in CONTRACT['jobs']:
        raise ValueError('UNKNOWN_JOB')
    attempts = []

    def attempt(_payload, n):
        attempts.append(n)
        return work()
    timer = Timer()
    op = Operation(f'{"export-worker" if job == "export" else "retention-worker" if job == "retention" else "recovery-journal"}',
                   f'job.{job}', idempotent=True, mutation=False)
    kwargs = {'classify': classify_job_error}
    if sleep is not None:
        kwargs['sleep'] = sleep
    try:
        value = execute(op, attempt, policy or RetryPolicy(max_attempts=3, base_delay_ms=500, max_delay_ms=2000), **kwargs)
        return {'outcome': 'success', 'attempts': len(attempts), 'error_class': 'NONE', 'duration_ms': timer.ms, 'value': value}
    except (NotRetryable, RetryExhausted) as error:
        cls = getattr(error, 'last_class', None) or error.error_class
        return {'outcome': 'failure', 'attempts': len(attempts), 'error_class': cls, 'duration_ms': timer.ms}


def export_job(db_url: str, storage_url: str, service_key: str, policy: RetryPolicy | None = None, sleep=None) -> dict:
    import export_worker
    return run_job('export', lambda: export_worker.run(db_url, storage_url, service_key), policy, sleep)


def retention_job(db_url: str, storage_url: str, key: str, organization_id: str, cutoff: str, authorization: str,
                  policy: RetryPolicy | None = None, sleep=None) -> dict:
    import purge_operational
    return run_job('retention', lambda: purge_operational.run(db_url, storage_url, key, organization_id, cutoff, authorization), policy, sleep)


def journal_reconcile(app_dsn: str, archive_dsn: str, policy: RetryPolicy | None = None, sleep=None) -> dict:
    import recovery_journal
    return run_job('recovery_journal', lambda: recovery_journal.reconcile(app_dsn, archive_dsn), policy, sleep)


def journal_check(app_dsn: str, archive_dsn: str, stale_minutes: float | None = None) -> dict:
    """OK / BLOCKED (unfinalized entries older than the threshold) / INCOHERENT."""
    import psycopg
    stale = (stale_minutes if stale_minutes is not None else CONTRACT['thresholds']['journal_unresolved_minutes']) * 60
    timer = Timer()
    counts = {'unresolved': 0, 'in_progress': 0, 'stale': 0, 'mismatch': 0}
    with psycopg.connect(app_dsn) as app, psycopg.connect(archive_dsn) as archive:
        source = app.execute('select id from private.journal_source').fetchone()[0]
        pending = archive.execute('''select e.id,e.transaction_id,extract(epoch from clock_timestamp()-e.created_at)
          from journal.entries e where e.source_id=%s and not exists(select 1 from journal.finalizations f where f.id=e.id)''',
                                  (source,)).fetchall()
        for entry_id, xid, age in pending:
            counts['unresolved'] += 1
            try:
                status = app.execute('select pg_xact_status(%s::xid8)', (xid,)).fetchone()[0]
            except psycopg.Error:
                app.rollback()
                status = None
            in_outbox = app.execute('select exists(select 1 from private.recovery_outbox where id=%s)', (entry_id,)).fetchone()[0]
            if status is None or (in_outbox and status == 'aborted'):
                counts['mismatch'] += 1
            elif status == 'in progress':
                counts['in_progress'] += 1
            if float(age) >= stale:
                counts['stale'] += 1
    status = 'INCOHERENT' if counts['mismatch'] else 'BLOCKED' if counts['stale'] else 'OK'
    LOG.emit('recovery-journal', 'journal.check', 'success' if status == 'OK' else 'failure', state={'OK': 'OK', 'BLOCKED': 'BLOCKED'}.get(status, 'UNKNOWN'),
             count=counts['unresolved'], error_class='NONE' if status == 'OK' else 'JOURNAL_MISMATCH' if status == 'INCOHERENT' else 'JOURNAL_UNRESOLVED',
             duration_ms=timer.ms)
    return {'status': status, **counts, 'checked_at': datetime.now(timezone.utc).isoformat()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='OPS-02 idempotent jobs and journal monitor (credentials via env names)')
    parser.add_argument('command', choices=['export', 'retention', 'journal-reconcile', 'journal-check'])
    parser.add_argument('--organization-id')
    parser.add_argument('--cutoff')
    parser.add_argument('--authorization-ref')
    args = parser.parse_args()
    env = os.environ
    if args.command == 'export':
        result = export_job(env['EXPORT_DATABASE_URL'], env['SUPABASE_URL'], env['SUPABASE_SERVICE_ROLE_KEY'])
    elif args.command == 'retention':
        result = retention_job(env['RETENTION_DATABASE_URL'], env['SUPABASE_URL'], env['SUPABASE_SERVICE_ROLE_KEY'],
                               args.organization_id, args.cutoff, args.authorization_ref)
    elif args.command == 'journal-reconcile':
        result = journal_reconcile(env['APP_DATABASE_URL'], env['ARCHIVE_DATABASE_URL'])
    else:
        result = journal_check(env['APP_DATABASE_URL'], env['ARCHIVE_DATABASE_URL'])
    result.pop('value', None)
    print(json.dumps(result, sort_keys=True))
    sys.exit(0 if result.get('outcome', 'success') == 'success' and result.get('status', 'OK') == 'OK' else 2)

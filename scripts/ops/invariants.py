"""OBS-05 invariant checker runner (read-only on labour data).

summary  -> monitor login, READ ONLY transaction, counts only (no identifiers)
record   -> monitor login, appends run/findings/baselines to OPS evidence only
findings -> reviewer login, one tenant at a time, READ ONLY (human review)
Nothing here can modify time_events, sessions, corrections or projections: the
entry roles have no table privilege and the definer only reads technical columns.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import LOG, OpsError, Timer, classify_exception  # noqa: E402


def _connect(dsn: str):
    import psycopg
    return psycopg.connect(dsn, application_name='ops-invariants')


def summary(dsn: str) -> dict:
    timer = Timer()
    try:
        with _connect(dsn) as connection:
            connection.execute('set transaction read only')
            rows = connection.execute('select invariant,severity,findings,tenants from private.ops_invariant_summary()').fetchall()
    except Exception as error:  # noqa: BLE001 -- classified, never serialized
        LOG.emit('invariants', 'invariants.check', 'failure', error_class=classify_exception(error), duration_ms=timer.ms)
        raise OpsError(classify_exception(error), 'invariants') from None
    result = {'summary': [{'invariant': r[0], 'severity': r[1], 'findings': int(r[2]), 'tenants': int(r[3])} for r in rows]}
    critical = sum(r['findings'] for r in result['summary'] if r['severity'] == 'CRITICAL')
    LOG.emit('invariants', 'invariants.check', 'success' if not critical else 'rejected', count=critical,
             error_class='NONE' if not critical else 'ASSERTION', duration_ms=timer.ms)
    return result


def record(dsn: str) -> dict:
    timer = Timer()
    with _connect(dsn) as connection:
        run = connection.execute('select private.ops_record_invariant_run()').fetchone()[0]
    LOG.emit('invariants', 'invariants.record', 'success', run_id=run['run_id'], count=run['critical'], duration_ms=timer.ms)
    return {'run_id': run['run_id'], 'critical': run['critical'], 'warning': run['warning'], 'info': run['info'],
            'summary': [{**row, 'tenants': None} for row in run['summary']]}


def findings(dsn: str, organization_id: str) -> list[dict]:
    with _connect(dsn) as connection:
        connection.execute('set transaction read only')
        rows = connection.execute('select invariant,severity,subject_kind,subject_id,detail from private.ops_invariant_findings(%s)',
                                  (organization_id,)).fetchall()
    return [{'invariant': r[0], 'severity': r[1], 'subject_kind': r[2], 'subject_id': str(r[3]) if r[3] else None, 'detail': r[4]} for r in rows]


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='OPS-02 read-only invariants (DSN only via environment variable name)')
    parser.add_argument('command', choices=['summary', 'record', 'findings'])
    parser.add_argument('--dsn-env', default='OPS_MONITOR_DSN')
    parser.add_argument('--org', help='tenant for human review (findings)')
    args = parser.parse_args()
    dsn = os.environ[args.dsn_env]
    if args.command == 'findings':
        if not args.org:
            parser.error('--org is required: detail is tenant-scoped')
        print(json.dumps(findings(dsn, args.org), indent=2, sort_keys=True))
    else:
        result = summary(dsn) if args.command == 'summary' else record(dsn)
        print(json.dumps(result, indent=2, sort_keys=True))
        sys.exit(2 if any(r['severity'] == 'CRITICAL' and r['findings'] for r in result['summary']) else 0)

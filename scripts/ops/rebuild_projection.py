"""RES-03: authorized reconstruction of private.employee_state ONLY.

Source of truth: immutable originals (public.time_events) plus adjustments of
APPROVE decisions (public.event_adjustments/correction_decisions), replayed by
the same private.validate_timeline() that H3 approvals use.
  --check   READ ONLY transaction, lists MATCH / DRIFT / BLOCKED / PURGED; never writes
  --apply   one employee, idempotent per --request-id, requires --authorization-ref;
            the database refuses (BLOCKED) when the immutable source is incoherent
            and verifies the rebuilt projection against the sources before commit.
Never touches originals, corrections, adjustments, sessions, audit or receipts.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from opslib import LOG, OpsError, Timer, classify_exception  # noqa: E402


def check(dsn: str, organization_id: str) -> list[dict]:
    import psycopg
    timer = Timer()
    with psycopg.connect(dsn, application_name='ops-projection-check') as connection:
        connection.execute('set transaction read only')
        rows = connection.execute('select employee_id,status,reasons,fields,projection,candidate from private.ops_projection_candidates(%s)',
                                  (organization_id,)).fetchall()
    result = [{'employee_id': str(r[0]), 'status': r[1], 'reasons': r[2], 'fields': r[3], 'projection': r[4], 'candidate': r[5]} for r in rows]
    drift = sum(1 for r in result if r['status'] != 'MATCH' and r['status'] != 'PURGED')
    LOG.emit('projection-rebuild', 'projection.check', 'success', count=drift, duration_ms=timer.ms)
    return result


def apply(dsn: str, organization_id: str, employee_id: str, authorization_ref: str, request_id: str | None = None) -> dict:
    import psycopg
    if not authorization_ref or not authorization_ref.strip():
        raise OpsError('INVALID_INPUT', 'authorization')
    request_id = request_id or str(uuid.uuid4())
    timer = Timer()
    try:
        with psycopg.connect(dsn, application_name='ops-projection-rebuild') as connection:
            result = connection.execute('select private.ops_rebuild_projection(%s,%s,%s,%s)',
                                        (organization_id, employee_id, request_id, authorization_ref)).fetchone()[0]
    except psycopg.Error as error:
        LOG.emit('projection-rebuild', 'projection.rebuild', 'failure', error_class=classify_exception(error),
                 request_id=request_id, duration_ms=timer.ms)
        raise OpsError(classify_exception(error), 'rebuild') from None
    outcome = {'APPLIED': 'success', 'NOOP': 'skipped', 'BLOCKED': 'rejected'}[result['outcome']]
    LOG.emit('projection-rebuild', 'projection.rebuild', outcome, state=result['outcome'], request_id=request_id,
             error_class='NONE' if outcome != 'rejected' else 'ASSERTION', duration_ms=timer.ms)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='OPS-02 projection rebuild (DSN only via environment variable name)')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--check', action='store_true', help='dry run: never writes')
    mode.add_argument('--apply', action='store_true')
    parser.add_argument('--org', required=True)
    parser.add_argument('--employee')
    parser.add_argument('--authorization-ref')
    parser.add_argument('--request-id')
    parser.add_argument('--dsn-env', default='OPS_REPAIR_DSN')
    args = parser.parse_args()
    dsn = os.environ[args.dsn_env]
    if args.check:
        print(json.dumps(check(dsn, args.org), indent=2, sort_keys=True))
    else:
        if not args.employee or not args.authorization_ref:
            parser.error('--apply requires --employee and --authorization-ref (explicit human authorization)')
        result = apply(dsn, args.org, args.employee, args.authorization_ref, args.request_id)
        print(json.dumps(result, indent=2, sort_keys=True))
        sys.exit(0 if result['outcome'] != 'BLOCKED' else 3)

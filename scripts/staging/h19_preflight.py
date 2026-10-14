"""H19 read-only staging precheck. NEVER migrates, deploys or authenticates.

A PASS here is necessary but NOT sufficient to operate remotely: the operator
must independently verify an actual isolated restore, external recovery journal,
Storage objects, provider settings, and access credentials (docs/H19_STAGING.md).
Only redacted status codes go to stdout; no secrets or backup content.
"""
from __future__ import annotations

import argparse
import json
import re
from datetime import datetime, timezone, timedelta
from pathlib import Path

STAGING_REF = 'pvfjffeszsedslmwdvgh'
STAGING_HOST = 'fichaje-staging.pages.dev'
PRODUCTION_REF = 'bypdviatamosygndeqhh'
REQUIRED_RESTORE_CHECKS = {
    'checksum', 'key', 'empty_target', 'schema_version', 'single_transaction', 'foreign_keys'
}
VERSION = re.compile(r'^\d{14}$')


def timestamp(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('no timezone')
    return parsed.astimezone(timezone.utc)


def evaluate(
    *, environment: str, project_ref: str, app_host: str,
    repository_versions: list[str], applied_versions: list[str],
    backup: dict | None, restore: dict | None,
    now: datetime,
) -> tuple[list[str], list[str]]:
    reasons: list[str] = []
    if (environment, project_ref, app_host) != ('staging', STAGING_REF, STAGING_HOST):
        reasons.append('TARGET_NOT_PINNED_TO_STAGING')
    if project_ref == PRODUCTION_REF:
        reasons.append('PRODUCTION_FORBIDDEN')
    if (not repository_versions or not applied_versions
        or any(not VERSION.fullmatch(v) for v in repository_versions + applied_versions)
        or len(set(repository_versions)) != len(repository_versions)
        or repository_versions != sorted(repository_versions)
        or applied_versions != repository_versions[:len(applied_versions)]):
        reasons.append('MIGRATION_DRIFT_OR_MISSING_HISTORY')
        pending: list[str] = []
    else:
        pending = repository_versions[len(applied_versions):]
    if backup is None:
        reasons.append('STAGING_BACKUP_NOT_PROVIDED')
    if restore is None:
        reasons.append('ISOLATED_RESTORE_NOT_PROVIDED')
    if backup is not None and restore is not None and applied_versions:
        try:
            created = timestamp(backup['completed_at'])
            restored = timestamp(restore['completed_at'])
            if (
                backup.get('schema') != 'fichaje.db-backup.v1'
                or backup.get('result') != 'success'
                or backup.get('encrypted') is not True
                or backup.get('encryption') != 'age-x25519'
                or backup.get('tls') != 'verify-full'
                or not re.fullmatch(r'[0-9a-f]{64}', backup.get('ciphertext_sha256', ''))
                or backup.get('migration_version') != applied_versions[-1]
                or created > now or now - created > timedelta(hours=24)
            ):
                reasons.append('BACKUP_NOT_FRESH_ENCRYPTED_OR_MATCHED')
            if (
                restore.get('schema') != 'fichaje.db-restore.v1'
                or restore.get('result') != 'success'
                or restore.get('backup') != backup.get('name')
                or restore.get('migration_version') != applied_versions[-1]
                or not REQUIRED_RESTORE_CHECKS <= set(restore.get('checks', []))
                or restored < created or restored > now
            ):
                reasons.append('RESTORE_RECEIPT_INVALID')
        except (ValueError, TypeError, KeyError):
            reasons.append('BACKUP_RESTORE_EVIDENCE_MALFORMED')
    return reasons, pending


def main() -> int:
    parser = argparse.ArgumentParser(description='Read-only H19 staging readiness precheck (never deploys)')
    parser.add_argument('--environment', required=True)
    parser.add_argument('--project-ref', required=True)
    parser.add_argument('--app-host', required=True)
    parser.add_argument('--applied-versions', required=True, type=Path,
                        help='Private operator snapshot: one migration version per line')
    parser.add_argument('--backup-manifest', type=Path)
    parser.add_argument('--restore-receipt', type=Path)
    args = parser.parse_args()
    repo_versions = sorted(p.name[:14] for p in
                           (Path(__file__).resolve().parents[2] / 'supabase' / 'migrations').glob('*.sql'))
    try:
        applied_versions = [v.strip() for v in args.applied_versions.read_text().splitlines() if v.strip()]
        backup = json.loads(args.backup_manifest.read_text()) if args.backup_manifest else None
        restore = json.loads(args.restore_receipt.read_text()) if args.restore_receipt else None
        reasons, pending = evaluate(
            environment=args.environment, project_ref=args.project_ref, app_host=args.app_host,
            repository_versions=repo_versions, applied_versions=applied_versions,
            backup=backup, restore=restore, now=datetime.now(timezone.utc),
        )
    except (OSError, ValueError, TypeError):
        reasons, pending = ['EVIDENCE_UNREADABLE'], []
    if reasons:
        print('H19: BLOCKED ' + ','.join(sorted(set(reasons))))
        return 2
    print(f'H19: PRECHECK_OK pending_migrations={len(pending)}')
    print('H19: NOT_AUTHORIZED_TO_DEPLOY independent restoration, journal and custody review still required')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

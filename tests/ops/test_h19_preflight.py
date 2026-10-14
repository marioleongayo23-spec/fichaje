"""H19 safety gate: no staging writes without fresh backup and restore receipts.

Synthetic metadata only. Evaluates necessary (not sufficient) prerequisites.
"""
from __future__ import annotations

import importlib.util
import unittest
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('h19_preflight', ROOT / 'scripts' / 'staging' / 'h19_preflight.py')
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(preflight)


class H19ReadOnlyPreflight(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 10, 14, 14, 0, tzinfo=timezone.utc)
        self.versions = ['20260921000100', '20261014000100', '20261014000200']
        done = (self.now - timedelta(hours=1)).isoformat()
        restored = (self.now - timedelta(minutes=50)).isoformat()
        self.backup = {
            'schema': 'fichaje.db-backup.v1', 'result': 'success',
            'encrypted': True, 'encryption': 'age-x25519', 'tls': 'verify-full',
            'name': 'synthetic-backup', 'ciphertext_sha256': 'a' * 64,
            'migration_version': self.versions[0], 'completed_at': done,
        }
        self.restore = {
            'schema': 'fichaje.db-restore.v1', 'result': 'success',
            'backup': 'synthetic-backup', 'migration_version': self.versions[0],
            'checks': sorted(preflight.REQUIRED_RESTORE_CHECKS),
            'completed_at': restored,
        }
        self.args = {
            'environment': 'staging',
            'project_ref': preflight.STAGING_REF,
            'app_host': preflight.STAGING_HOST,
            'repository_versions': self.versions,
            'applied_versions': self.versions[:1],
            'backup': self.backup, 'restore': self.restore, 'now': self.now,
        }

    def result(self, **overrides):
        return preflight.evaluate(**{**self.args, **overrides})

    def test_expected_versions_and_backup_receipt_pass_precheck_only(self):
        reasons, pending = self.result()
        self.assertEqual(reasons, [])
        self.assertEqual(pending, self.versions[1:])

    def test_no_evidence_always_blocks(self):
        reasons, _ = self.result(backup=None, restore=None)
        self.assertIn('STAGING_BACKUP_NOT_PROVIDED', reasons)
        self.assertIn('ISOLATED_RESTORE_NOT_PROVIDED', reasons)

    def test_production_or_unpinned_target_never_passes(self):
        for kwargs in [
            {'project_ref': preflight.PRODUCTION_REF},
            {'environment': 'production'},
            {'app_host': 'fichaje.pages.dev'},
            {'app_host': 'fichaje-staging.pages.dev.evil.invalid'},
        ]:
            reasons, _ = self.result(**kwargs)
            self.assertIn('TARGET_NOT_PINNED_TO_STAGING', reasons)

    def test_migration_drift_and_missing_base_history_blocks(self):
        for applied in [
            [], [self.versions[1]], [self.versions[0], '20261001000000'],
            [self.versions[0], self.versions[0]], self.versions + ['20271001000000'],
        ]:
            reasons, _ = self.result(applied_versions=applied)
            self.assertIn('MIGRATION_DRIFT_OR_MISSING_HISTORY', reasons)

    def test_stale_or_unencrypted_backup_rejected(self):
        for changed in [
            {'encrypted': False},
            {'tls': 'require'},
            {'completed_at': (self.now-timedelta(days=2)).isoformat()},
            {'migration_version': self.versions[-1]},
            {'ciphertext_sha256': 'not-a-hash'},
        ]:
            reasons, _ = self.result(backup={**self.backup, **changed})
            self.assertIn('BACKUP_NOT_FRESH_ENCRYPTED_OR_MATCHED', reasons)

    def test_other_backup_or_unproven_restore_rejected(self):
        for changed in [
            {'backup': 'unrelated-backup'},
            {'checks': ['checksum']},
            {'migration_version': self.versions[-1]},
            {'completed_at': (self.now-timedelta(hours=2)).isoformat()},
            {'result': 'failed'},
        ]:
            reasons, _ = self.result(restore={**self.restore, **changed})
            self.assertIn('RESTORE_RECEIPT_INVALID', reasons)

    def test_malformed_evidence_fails_closed(self):
        reasons, _ = self.result(restore={**self.restore, 'completed_at': 'not-a-time'})
        self.assertIn('BACKUP_RESTORE_EVIDENCE_MALFORMED', reasons)


if __name__ == '__main__':
    unittest.main()

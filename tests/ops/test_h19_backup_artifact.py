"""Unit coverage for the H19 read-only artifact verifier (synthetic bytes)."""
import hashlib
import json
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "staging"))
from h19_backup_artifact import check  # noqa: E402

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)
NAME = "fichaje-db-20261014T113000Z-aabbccdd"
MIGRATION = "20260930000200"


class H19BackupArtifact(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.cipher = self.directory / (NAME + ".dump.age")
        self.manifest_file = self.directory / (NAME + ".manifest.json")
        self.sha_file = self.directory / (NAME + ".dump.age.sha256")
        self.cipher.write_bytes(b"age-encryption.org/v1\n" + b"synthetic-cipher-bytes")
        self.sha = hashlib.sha256(self.cipher.read_bytes()).hexdigest()
        self.manifest = {
            "schema": "fichaje.db-backup.v1", "name": NAME,
            "result": "success", "encrypted": True, "encryption": "age-x25519",
            "ciphertext": NAME + ".dump.age", "ciphertext_sha256": self.sha,
            "ciphertext_bytes": self.cipher.stat().st_size,
            "migration_version": MIGRATION, "tls": "verify-full",
            "format": "custom", "content": "data-only",
            "completed_at": (NOW - timedelta(minutes=10)).isoformat(),
            "restore_test": None,
        }
        self.sync()

    def sync(self):
        self.manifest_file.write_text(json.dumps(self.manifest))
        self.sha_file.write_text(self.sha + "  " + NAME + ".dump.age\n")

    def verify(self, name=NAME, migration=MIGRATION):
        return check(self.directory, name, migration, now=NOW)

    def test_integrity_pass_is_not_restore_pass(self):
        outcome = self.verify()
        self.assertEqual(outcome["artifact_integrity"], "PASS")
        self.assertEqual(outcome["freshness"], "PASS")
        self.assertEqual(outcome["restore"], "NOT_TESTED")
        self.assertFalse(outcome["ready_for_migration"])

    def test_old_archive_stale(self):
        self.manifest["completed_at"] = (NOW - timedelta(days=12)).isoformat()
        self.sync()
        outcome = self.verify()
        self.assertEqual(outcome["artifact_integrity"], "PASS")
        self.assertEqual(outcome["freshness"], "STALE_OR_FUTURE")
        self.assertFalse(outcome["ready_for_migration"])

    def test_corrupted_ciphertext_refused(self):
        self.cipher.write_bytes(self.cipher.read_bytes() + b"tampering")
        self.assertEqual(self.verify()["reason"], "CHECKSUM_OR_CIPHERTEXT_MISMATCH")

    def test_wrong_checksum_file_refused(self):
        self.sha_file.write_text("0" * 64 + "  " + NAME + ".dump.age\n")
        self.assertEqual(self.verify()["reason"], "CHECKSUM_OR_CIPHERTEXT_MISMATCH")

    def test_migration_drift_refused(self):
        self.assertEqual(self.verify(migration="20261014000100")["reason"], "MANIFEST_MISMATCH")

    def test_path_traversal_refused(self):
        self.assertEqual(self.verify(name="../other")["reason"], "INVALID_INPUT")

    def test_missing_cipher_refused(self):
        self.cipher.unlink()
        self.assertEqual(self.verify()["reason"], "ARTIFACT_MISSING_OR_UNSAFE")

    def test_symlink_refused(self):
        self.cipher.unlink()
        self.cipher.symlink_to(self.manifest_file)
        self.assertEqual(self.verify()["reason"], "ARTIFACT_MISSING_OR_UNSAFE")

    def test_future_timestamp_refused(self):
        self.manifest["completed_at"] = (NOW + timedelta(hours=3)).isoformat()
        self.sync()
        self.assertEqual(self.verify()["freshness"], "STALE_OR_FUTURE")

    def test_plaintext_refused(self):
        self.cipher.write_bytes(b"PGDMP" + b"x" * 40)
        digest = hashlib.sha256(self.cipher.read_bytes()).hexdigest()
        self.sha = digest
        self.manifest["ciphertext_sha256"] = digest
        self.manifest["ciphertext_bytes"] = self.cipher.stat().st_size
        self.sync()
        self.assertEqual(self.verify()["reason"], "CHECKSUM_OR_CIPHERTEXT_MISMATCH")


if __name__ == "__main__":
    unittest.main()

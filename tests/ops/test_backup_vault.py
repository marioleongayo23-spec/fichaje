from __future__ import annotations

import hashlib
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts" / "ops"))
import backup_vault  # noqa: E402


class BackupVaultPackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.name = "fichaje-db-20261002T100304Z-deadbeef"
        self.cipher = b"age-encryption.org/v1\nsynthetic-ciphertext"
        self.digest = hashlib.sha256(self.cipher).hexdigest()
        (self.root / f"{self.name}.dump.age").write_bytes(self.cipher)
        (self.root / f"{self.name}.dump.age.sha256").write_text(
            f"{self.digest}  {self.name}.dump.age\n", encoding="utf-8"
        )
        manifest = {
            "schema": "fichaje.db-backup.v1",
            "result": "success",
            "name": self.name,
            "encrypted": True,
            "encryption": "age-x25519",
            "ciphertext": f"{self.name}.dump.age",
            "ciphertext_sha256": self.digest,
            "ciphertext_bytes": len(self.cipher),
            "tls": "verify-full",
        }
        (self.root / f"{self.name}.manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_valid_package_returns_three_verified_artifacts(self):
        artifacts = backup_vault.load_package(self.root, self.name)
        self.assertEqual(len(artifacts), 3)
        self.assertEqual(artifacts[0].sha256, self.digest)
        self.assertEqual(artifacts[0].size_bytes, len(self.cipher))

    def test_tamper_fails_closed(self):
        path = self.root / f"{self.name}.dump.age"
        path.write_bytes(self.cipher + b"x")
        with self.assertRaisesRegex(backup_vault.VaultError, "CHECKSUM_MISMATCH"):
            backup_vault.load_package(self.root, self.name)

    def test_private_age_key_marker_is_rejected(self):
        path = self.root / f"{self.name}.manifest.json"
        path.write_bytes(path.read_bytes() + b"AGE-SECRET-KEY-1")
        with self.assertRaisesRegex(backup_vault.VaultError, "AGE_PRIVATE_KEY_PRESENT"):
            backup_vault.load_package(self.root, self.name)

    def test_manifest_mismatch_is_rejected(self):
        path = self.root / f"{self.name}.manifest.json"
        manifest = json.loads(path.read_text("utf-8"))
        manifest["tls"] = "require"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        with self.assertRaisesRegex(backup_vault.VaultError, "MANIFEST_MISMATCH:tls"):
            backup_vault.load_package(self.root, self.name)

    def test_connection_info_requires_owner_only_external_files_and_verify_full(self):
        service = self.root / "service.conf"
        password = self.root / "pgpass"
        ca = self.root / "ca.crt"
        service.write_text("[vault]\nhost=example.invalid\ndbname=neondb\nuser=vault\n", encoding="utf-8")
        password.write_text("example.invalid:5432:neondb:vault:synthetic\n", encoding="utf-8")
        ca.write_text("-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n", encoding="utf-8")
        os.chmod(service, stat.S_IRUSR | stat.S_IWUSR)
        os.chmod(password, stat.S_IRUSR | stat.S_IWUSR)
        os.chmod(ca, stat.S_IRUSR | stat.S_IWUSR)
        env = {
            "FICHAJE_BACKUP_VAULT_PGSERVICE": "vault",
            "PGSERVICEFILE": str(service),
            "PGPASSFILE": str(password),
            "FICHAJE_BACKUP_VAULT_CA": str(ca),
        }
        with mock.patch.dict(os.environ, env, clear=False):
            conninfo = backup_vault.connection_info()
        self.assertIn("sslmode=verify-full", conninfo)
        self.assertIn(f"sslrootcert={ca}", conninfo)
        self.assertNotIn("synthetic", conninfo)


if __name__ == "__main__":
    unittest.main()

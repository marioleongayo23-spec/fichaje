"""H19 read-only integrity/freshness check of an encrypted staging DB archive.

Never connects to Supabase, decrypts files, reads secrets or writes data.
An archive passing THIS check still requires a separate isolated restore,
journal replay, invariants, source-provenance check and operator approval.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

NAME = re.compile(r"^fichaje-db-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$")
SHA = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[0-9]{14}$")


def check(directory: Path, name: str, expected_migration: str,
          now: datetime | None = None, max_age_hours: float = 24.0) -> dict:
    """Return safe status fields only. Does not certify DB recovery."""
    result = {"artifact_integrity": "BLOCKED", "freshness": "UNVERIFIED",
              "restore": "NOT_TESTED", "provenance": "UNVERIFIED",
              "ready_for_migration": False, "reason": "INVALID_INPUT"}
    if not NAME.fullmatch(name) or not VERSION.fullmatch(expected_migration) or max_age_hours <= 0:
        return result
    if directory.is_symlink() or not directory.is_dir():
        return {**result, "reason": "INVALID_DIRECTORY"}
    cipher = directory / (name + ".dump.age")
    manifest_file = directory / (name + ".manifest.json")
    checksum_file = directory / (name + ".dump.age.sha256")
    files = (cipher, manifest_file, checksum_file)
    if any(f.is_symlink() or not f.is_file() or f.stat().st_size == 0 for f in files):
        return {**result, "reason": "ARTIFACT_MISSING_OR_UNSAFE"}
    if manifest_file.stat().st_size > 16384 or checksum_file.stat().st_size > 256:
        return {**result, "reason": "INVALID_MANIFEST"}
    try:
        manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
        completed = datetime.fromisoformat(manifest["completed_at"].replace("Z", "+00:00"))
        expected_sha = manifest["ciphertext_sha256"]
        recorded_bytes = manifest["ciphertext_bytes"]
        migration = manifest["migration_version"]
    except (ValueError, KeyError, TypeError, UnicodeError, OSError):
        return {**result, "reason": "INVALID_MANIFEST"}
    if not isinstance(manifest, dict) or any((
        manifest.get("schema") != "fichaje.db-backup.v1",
        manifest.get("name") != name,
        manifest.get("result") != "success",
        manifest.get("encrypted") is not True,
        manifest.get("encryption") != "age-x25519",
        manifest.get("ciphertext") != name + ".dump.age",
        manifest.get("tls") != "verify-full",
        manifest.get("format") != "custom",
        manifest.get("content") != "data-only",
        migration != expected_migration,
        not isinstance(expected_sha, str) or not SHA.fullmatch(expected_sha),
        not isinstance(recorded_bytes, int) or recorded_bytes <= 0,
        completed.tzinfo is None
    )):
        return {**result, "reason": "MANIFEST_MISMATCH"}
    expected_line = expected_sha + "  " + name + ".dump.age"
    try:
        actual_line = checksum_file.read_text(encoding="ascii").strip()
        with cipher.open("rb") as stream:
            prefix = stream.read(21)
            stream.seek(0)
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if (prefix != b"age-encryption.org/v1" or actual_line != expected_line
                or cipher.stat().st_size != recorded_bytes or digest.hexdigest() != expected_sha):
            return {**result, "reason": "CHECKSUM_OR_CIPHERTEXT_MISMATCH"}
    except (OSError, UnicodeError):
        return {**result, "reason": "UNREADABLE_ARTIFACT"}
    now = now or datetime.now(timezone.utc)
    age = now - completed
    good_age = timedelta(minutes=-5) <= age <= timedelta(hours=max_age_hours)
    return {"artifact_integrity": "PASS",
            "freshness": "PASS" if good_age else "STALE_OR_FUTURE",
            "restore": "NOT_TESTED", "provenance": "UNVERIFIED",
            "ready_for_migration": False,
            "reason": "ARTIFACT_ONLY_NOT_A_RESTORE" if good_age else "BACKUP_NOT_FRESH"}


def main() -> int:
    parser = argparse.ArgumentParser(description="H19 fail-closed, read-only encrypted backup artifact verifier")
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--backup-name", required=True)
    parser.add_argument("--expected-migration", required=True)
    parser.add_argument("--max-age-hours", type=float, default=24.0)
    args = parser.parse_args()
    result = check(args.directory, args.backup_name, args.expected_migration,
                   max_age_hours=args.max_age_hours)
    print(json.dumps(result, sort_keys=True))
    return 0 if result["artifact_integrity"] == "PASS" and result["freshness"] == "PASS" else 2


if __name__ == "__main__":
    sys.exit(main())

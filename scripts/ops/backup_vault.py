#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import sys
from dataclasses import dataclass
from pathlib import Path

import psycopg

NAME_RE = re.compile(r"^fichaje-db-\d{8}T\d{6}Z-[0-9a-f]{8}$")
PRIVATE_KEY_MARKER = b"AGE-SECRET-KEY-1"


class VaultError(RuntimeError):
    pass


@dataclass(frozen=True)
class Artifact:
    object_key: str
    content_type: str
    sha256: str
    size_bytes: int
    payload: bytes


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _regular(path: Path) -> bool:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError:
        return False
    return stat.S_ISREG(mode) and not path.is_symlink()


def _owner_only(path: Path) -> bool:
    if not _regular(path):
        return False
    mode = stat.S_IMODE(path.stat().st_mode)
    return mode == 0o600 and path.stat().st_uid == os.getuid()


def load_package(directory: str | Path, name: str) -> list[Artifact]:
    if not NAME_RE.fullmatch(name):
        raise VaultError("INVALID_BACKUP_NAME")
    root = Path(directory)
    if not root.is_dir():
        raise VaultError("BACKUP_DIRECTORY_MISSING")

    cipher = root / f"{name}.dump.age"
    checksum = root / f"{name}.dump.age.sha256"
    manifest_path = root / f"{name}.manifest.json"
    for path in (cipher, checksum, manifest_path):
        if not _regular(path):
            raise VaultError(f"BACKUP_FILE_INVALID:{path.name}")

    cipher_bytes = cipher.read_bytes()
    checksum_bytes = checksum.read_bytes()
    manifest_bytes = manifest_path.read_bytes()
    if any(PRIVATE_KEY_MARKER in value for value in (cipher_bytes, checksum_bytes, manifest_bytes)):
        raise VaultError("AGE_PRIVATE_KEY_PRESENT")

    if not cipher_bytes.startswith(b"age-encryption.org/v1"):
        raise VaultError("CIPHERTEXT_HEADER_INVALID")

    digest = _sha(cipher_bytes)
    sidecar = checksum_bytes.decode("utf-8").strip().split()
    if len(sidecar) != 2 or sidecar[0] != digest or sidecar[1] != cipher.name:
        raise VaultError("CHECKSUM_MISMATCH")

    try:
        manifest = json.loads(manifest_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VaultError("MANIFEST_INVALID") from exc

    required = {
        "schema": "fichaje.db-backup.v1",
        "result": "success",
        "name": name,
        "encrypted": True,
        "encryption": "age-x25519",
        "ciphertext": cipher.name,
        "ciphertext_sha256": digest,
        "ciphertext_bytes": len(cipher_bytes),
        "tls": "verify-full",
    }
    for key, expected in required.items():
        if manifest.get(key) != expected:
            raise VaultError(f"MANIFEST_MISMATCH:{key}")

    return [
        Artifact(cipher.name, "application/octet-stream", digest, len(cipher_bytes), cipher_bytes),
        Artifact(checksum.name, "text/plain", _sha(checksum_bytes), len(checksum_bytes), checksum_bytes),
        Artifact(manifest_path.name, "application/json", _sha(manifest_bytes), len(manifest_bytes), manifest_bytes),
    ]


def connection_info() -> str:
    service = os.environ.get("FICHAJE_BACKUP_VAULT_PGSERVICE", "")
    service_file = Path(os.environ.get("PGSERVICEFILE", ""))
    pass_file = Path(os.environ.get("PGPASSFILE", ""))
    ca = Path(os.environ.get("FICHAJE_BACKUP_VAULT_CA", ""))

    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", service):
        raise VaultError("VAULT_SERVICE_INVALID")
    if not _owner_only(service_file):
        raise VaultError("PGSERVICEFILE_NOT_OWNER_ONLY")
    if not _owner_only(pass_file):
        raise VaultError("PGPASSFILE_NOT_OWNER_ONLY")
    if not _regular(ca):
        raise VaultError("VAULT_CA_INVALID")
    ca_bytes = ca.read_bytes()
    if b"BEGIN CERTIFICATE" not in ca_bytes or b"PRIVATE KEY" in ca_bytes:
        raise VaultError("VAULT_CA_INVALID")

    service_text = service_file.read_text("utf-8")
    if f"[{service}]" not in service_text:
        raise VaultError("VAULT_SERVICE_MISSING")
    if re.search(r"(?im)^\s*password\s*=", service_text):
        raise VaultError("PASSWORD_IN_SERVICE_FILE")

    return (
        f"service={service} sslmode=verify-full sslrootcert={ca} "
        "application_name=fichaje-backup-vault connect_timeout=15"
    )


def upload(directory: str | Path, name: str) -> None:
    artifacts = load_package(directory, name)
    conninfo = connection_info()
    with psycopg.connect(conninfo) as conn:
        with conn.cursor() as cur:
            for artifact in artifacts:
                cur.execute(
                    """
                    insert into backup_vault.objects
                      (object_key,backup_name,content_type,sha256,size_bytes,payload)
                    values (%s,%s,%s,%s,%s,%s)
                    on conflict (object_key) do nothing
                    """,
                    (
                        artifact.object_key,
                        name,
                        artifact.content_type,
                        artifact.sha256,
                        artifact.size_bytes,
                        psycopg.Binary(artifact.payload),
                    ),
                )
                cur.execute(
                    """
                    select sha256,size_bytes,
                           encode(digest(payload,'sha256'),'hex')
                    from backup_vault.objects
                    where object_key=%s
                    """,
                    (artifact.object_key,),
                )
                row = cur.fetchone()
                expected = (artifact.sha256, artifact.size_bytes, artifact.sha256)
                if row != expected:
                    raise VaultError(f"REMOTE_VERIFY_FAILED:{artifact.object_key}")
        conn.commit()
    print(f"BACKUP_VAULT_UPLOAD=PASS name={name} files={len(artifacts)}")


def purge() -> None:
    conninfo = connection_info()
    with psycopg.connect(conninfo) as conn:
        with conn.cursor() as cur:
            cur.execute("select backup_vault.purge_expired()")
            count = int(cur.fetchone()[0])
        conn.commit()
    print(f"BACKUP_VAULT_PURGE=PASS purged={count}")


def main(argv: list[str]) -> int:
    try:
        if len(argv) == 4 and argv[1] == "upload":
            upload(argv[2], argv[3])
        elif len(argv) == 2 and argv[1] == "purge":
            purge()
        else:
            raise VaultError("USAGE: backup_vault.py upload <backup_dir> <backup_name> | purge")
        return 0
    except VaultError as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"FAILED: VAULT_DB_ERROR:{exc.__class__.__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

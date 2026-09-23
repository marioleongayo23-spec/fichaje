"""Offline H5 worker. Connect with an operator DB credential, SET ROLE to the
NOLOGIN worker and use an ephemeral server-only Storage key. Never run in a
browser or with real credentials in CI. A failed upload never marks READY.
"""
from __future__ import annotations

import argparse
import hashlib
import os
from urllib.parse import quote
from urllib.request import Request, urlopen

import psycopg

from export_package import package


def storage(method: str, url: str, key: str, body: bytes | None = None) -> bytes:
    headers = {"apikey": key, "Authorization": "Bearer " + key,
               "Cache-Control": "no-store", "Content-Type": "application/zip"}
    if method == "POST":
        headers["x-upsert"] = "true"
    with urlopen(Request(url, data=body, headers=headers, method=method), timeout=15) as response:
        return response.read()


def run(db_url: str, storage_url: str, storage_key: str) -> int:
    processed = 0
    with psycopg.connect(db_url) as connection:
        # One bounded transaction per job. The service key never enters SQL.
        while True:
            with connection.transaction():
                with connection.cursor() as cursor:
                    cursor.execute("set local role fichaje_export_worker")
                    cursor.execute("""select organization_id,id,snapshot from private.export_jobs
                        where status='PENDING' and expires_at>clock_timestamp()
                        order by created_at,id for update skip locked limit 1""")
                    row = cursor.fetchone()
                    if row is None:
                        return processed
                    organization_id, job_id, snapshot = row
                    archive, digest = package(snapshot)
                    path = f"{organization_id}/{job_id}.zip"
                    url = storage_url.rstrip("/") + "/storage/v1/object/fichaje-evidence/" + quote(path)
                    try:
                        storage("POST", url, storage_key, archive)
                        downloaded = storage("GET", url, storage_key)
                        if hashlib.sha256(downloaded).hexdigest() != digest:
                            raise RuntimeError("EXPORT_VERIFY_FAILED")
                        cursor.execute("""update private.export_jobs set status='READY',checksum=%s,object_path=%s
                            where organization_id=%s and id=%s and status='PENDING' and expires_at>clock_timestamp()""",
                            (digest, path, organization_id, job_id))
                        if cursor.rowcount != 1:
                            raise RuntimeError("EXPORT_EXPIRED")
                    except Exception:
                        # This is compensation for a private orphan. Errors remain
                        # visible to the operator; no READY record is committed.
                        try:
                            storage("DELETE", url, storage_key)
                        except Exception:
                            pass
                        raise
                    processed += 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--local-only", action="store_true", required=True)
    args = parser.parse_args()
    assert args.local_only
    print("processed:", run(os.environ["EXPORT_DATABASE_URL"], os.environ["SUPABASE_URL"],
                            os.environ["SUPABASE_SERVICE_ROLE_KEY"]))

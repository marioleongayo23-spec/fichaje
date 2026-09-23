"""Offline-only temporary object cleanup, followed by transactional SQL expiry.
Requires an explicit authorization reference. Never invoked by the product API.
"""
import argparse
import os
import json
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

import psycopg
from export_worker import storage


def is_missing(error: HTTPError) -> bool:
    if error.code == 404:
        return True
    try:
        body = json.loads(error.read())
    except (ValueError, UnicodeError):
        return False
    return error.code == 400 and str(body.get('statusCode')) == '404'


def run(db_url: str, storage_url: str, key: str, organization_id: str,
        cutoff: str, authorization: str) -> str:
    with psycopg.connect(db_url) as connection:
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.execute("set local role fichaje_retention_operator")
                cursor.execute("select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(%s,39))",
                               (organization_id,))
                cursor.execute("""select exists(select 1 from private.legal_holds h
                    where h.organization_id=%s and h.release_of is null
                    and not exists(select 1 from private.legal_holds r
                        where r.organization_id=h.organization_id and r.release_of=h.id))""",
                    (organization_id,))
                if cursor.fetchone()[0]:
                    raise RuntimeError("LEGAL_HOLD")
                cursor.execute("""select coalesce(object_path,organization_id::text||'/'||id::text||'.zip') from private.export_jobs
                    where organization_id=%s and expires_at<=%s""",
                    (organization_id, cutoff))
                for (path,) in cursor.fetchall():
                    url = storage_url.rstrip("/") + "/storage/v1/object/fichaje-evidence/" + quote(path)
                    headers = {"apikey": key, "Authorization": "Bearer " + key, "Cache-Control": "no-store"}
                    try:
                        storage('DELETE',url,key)
                    except HTTPError as error:
                        if not is_missing(error):
                            raise
                    try:
                        with urlopen(Request(url, headers=headers), timeout=15):
                            raise RuntimeError("OBJECT_STILL_PRESENT")
                    except HTTPError as error:
                        if not is_missing(error):
                            raise
                cursor.execute("select private.purge_operational(%s,%s,%s)",
                               (organization_id, cutoff, authorization))
                return str(cursor.fetchone()[0])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--organization-id", required=True)
    parser.add_argument("--cutoff", required=True)
    parser.add_argument("--authorization-ref", required=True)
    args = parser.parse_args()
    print(run(os.environ["RETENTION_DATABASE_URL"], os.environ["SUPABASE_URL"],
              os.environ["SUPABASE_SERVICE_ROLE_KEY"], args.organization_id,
              args.cutoff, args.authorization_ref))

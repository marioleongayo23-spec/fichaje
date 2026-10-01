"""Provision only the disposable CI journal DB, separately from the app dump.
No credential or journal entry is printed or saved as an Actions artifact.
"""
import secrets
import subprocess
import sys
from pathlib import Path

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
# Append-only archive schema shared with the REC drill and the operator (H7).
from recovery_archive import ARCHIVE_SCHEMA  # noqa: E402

APP = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
ARCHIVE = 'postgresql://postgres:postgres@127.0.0.1:54322/fichaje_recovery'


def initialize():
    subprocess.run(['docker','exec','-i','supabase_db_fichaje-h1','psql','-U','supabase_admin',
        '-d','postgres','-v','ON_ERROR_STOP=1','-c',
        'grant usage on foreign data wrapper dblink_fdw to postgres'],check=True,stdout=subprocess.DEVNULL)
    hba = subprocess.check_output(['docker','exec','supabase_db_fichaje-h1','psql','-U','supabase_admin',
        '-d','postgres','-Atc','show hba_file']).decode().strip()
    # The local image trusts loopback by default. dblink correctly refuses to
    # lend non-superuser authority through trust. Require SCRAM for this one
    # synthetic archive identity rather than widening any database role.
    subprocess.run(['docker','exec','supabase_db_fichaje-h1','sh','-c',
        'tmp=$(mktemp); printf "%s\\n" "host fichaje_recovery fichaje_archive_connection 127.0.0.1/32 scram-sha-256" > "$tmp"; cat "$1" >> "$tmp"; cat "$tmp" > "$1"; rm "$tmp"',
        'journal-hba',hba],check=True)
    subprocess.run(['docker','exec','supabase_db_fichaje-h1','psql','-U','supabase_admin','-d','postgres',
        '-v','ON_ERROR_STOP=1','-c','select pg_reload_conf()'],check=True,stdout=subprocess.DEVNULL)
    password = secrets.token_urlsafe(40)
    with psycopg.connect(APP, autocommit=True) as c:
        c.execute("set password_encryption='scram-sha-256'")
        c.execute('create database fichaje_recovery')
        c.execute(sql.SQL('create role fichaje_archive_connection login noinherit password {}').format(sql.Literal(password)))
        c.execute('create role fichaje_archive_writer nologin noinherit nobypassrls')
        c.execute('grant fichaje_archive_writer to postgres')
    with psycopg.connect(ARCHIVE) as c:
        c.execute(ARCHIVE_SCHEMA)
    with psycopg.connect(APP) as c:
        c.execute('''create server fichaje_recovery foreign data wrapper dblink_fdw
          options(host '127.0.0.1',port '5432',dbname 'fichaje_recovery');
          grant usage on foreign server fichaje_recovery to fichaje_journal;''')
        c.execute(sql.SQL('create user mapping for fichaje_journal server fichaje_recovery options(user {},password {})').format(
            sql.Literal('fichaje_archive_connection'), sql.Literal(password)))


if __name__ == '__main__':
    initialize()
    print('Independent synthetic recovery journal initialized')

#!/usr/bin/env bash
# GO-LIVE: provision the independent recovery journal using the two existing
# Supabase projects. Secrets are entered interactively and never accepted as
# command-line arguments, written to Git or printed.
set -euo pipefail
umask 077

STAGING_DB_HOST="${FICHAJE_STAGING_DB_HOST:-db.pvfjffeszsedslmwdvgh.supabase.co}"
PRODUCTION_DB_HOST="${FICHAJE_PRODUCTION_DB_HOST:-db.bypdviatamosygndeqhh.supabase.co}"
DB_PORT="${FICHAJE_DB_PORT:-5432}"
DB_NAME="${FICHAJE_DB_NAME:-postgres}"
DB_ADMIN_USER="${FICHAJE_DB_ADMIN_USER:-postgres}"

blocked() { printf 'BLOCKED: %s\n' "$1" >&2; exit 2; }
failed() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }

for tool in psql openssl; do
  command -v "$tool" >/dev/null || blocked "$tool is not installed"
done
major="$(psql --version | sed -E 's/.* ([0-9]+).*/\1/' | head -1)"
[[ "$major" =~ ^[0-9]+$ ]] && (( major >= 17 )) || blocked 'PostgreSQL client 17+ is required'

read -r -s -p 'Staging database admin password: ' staging_admin
printf '\n' >&2
read -r -s -p 'Production database admin password: ' production_admin
printf '\n' >&2
[[ -n "$staging_admin" && -n "$production_admin" ]] || blocked 'both database passwords are required'

archive_password="$(openssl rand -hex 32)"
work="$(mktemp -d "${TMPDIR:-/tmp}/fichaje-journal-XXXXXX")"
chmod 700 "$work"
passfile="$work/pgpass"
escape_pgpass() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/:/\\:/g'; }
{
  printf '%s:%s:%s:%s:%s\n' "$STAGING_DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_ADMIN_USER" "$(escape_pgpass "$staging_admin")"
  printf '%s:%s:%s:%s:%s\n' "$PRODUCTION_DB_HOST" "$DB_PORT" "$DB_NAME" "$DB_ADMIN_USER" "$(escape_pgpass "$production_admin")"
} > "$passfile"
chmod 600 "$passfile"
export PGPASSFILE="$passfile"
unset staging_admin production_admin

staging_conn="host=$STAGING_DB_HOST port=$DB_PORT dbname=$DB_NAME user=$DB_ADMIN_USER sslmode=verify-full sslrootcert=system connect_timeout=15 application_name=fichaje-go-live-journal"
production_conn="host=$PRODUCTION_DB_HOST port=$DB_PORT dbname=$DB_NAME user=$DB_ADMIN_USER sslmode=verify-full sslrootcert=system connect_timeout=15 application_name=fichaje-go-live-journal"

created_archive=0
created_link=0
complete=0
cleanup() {
  rc=$?
  if [[ $complete -eq 0 ]]; then
    if [[ $created_link -eq 1 ]]; then
      psql "$production_conn" -Xq -v ON_ERROR_STOP=1 -c 'drop server if exists fichaje_recovery cascade;' >/dev/null 2>&1 || true
    fi
    if [[ $created_archive -eq 1 ]]; then
      # Safe only because preflight required an empty/nonexistent archive and
      # production was not live. Never delete a populated journal.
      rows="$(psql "$staging_conn" -XAtq -c "select case when to_regclass('journal.entries') is null then 0 else (select count(*) from journal.entries) end" 2>/dev/null || printf '1')"
      if [[ "$rows" == "0" ]]; then
        psql "$staging_conn" -Xq -v ON_ERROR_STOP=1 <<'SQL' >/dev/null 2>&1 || true
drop schema if exists journal cascade;
drop role if exists fichaje_archive_connection;
drop role if exists fichaje_archive_writer;
SQL
      fi
    fi
  fi
  archive_password=''
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT HUP INT TERM

preflight_staging="$(psql "$staging_conn" -XAtq -v ON_ERROR_STOP=1 -c "
select
  (exists(select 1 from pg_roles where rolname in ('fichaje_archive_connection','fichaje_archive_writer'))
   or exists(select 1 from pg_namespace where nspname='journal'))::int;")" || failed 'cannot connect to staging with TLS verify-full'
[[ "$preflight_staging" == "0" ]] || blocked 'staging archive roles/schema already exist; inspect before retrying'

preflight_prod="$(psql "$production_conn" -XAtq -v ON_ERROR_STOP=1 -c "
select exists(select 1 from pg_foreign_server where srvname='fichaje_recovery')::int;")" || failed 'cannot connect to production with TLS verify-full'
[[ "$preflight_prod" == "0" ]] || blocked 'production foreign server fichaje_recovery already exists; inspect before retrying'

# Password is generated as lowercase hex, so SQL literal interpolation is safe
# and does not require escaping. It is never logged or persisted after setup.
psql "$staging_conn" -Xq -v ON_ERROR_STOP=1 <<SQL
begin;
create role fichaje_archive_connection login noinherit nobypassrls password '$archive_password';
create role fichaje_archive_writer nologin noinherit nobypassrls;
grant fichaje_archive_writer to postgres;

create schema journal authorization fichaje_archive_writer;
revoke all on schema journal from public, anon, authenticated, service_role;
grant usage on schema journal to fichaje_archive_connection, fichaje_archive_writer;

create table journal.entries (
  ordinal bigint generated always as identity primary key,
  id uuid unique not null,
  source_id uuid not null,
  transaction_id text not null,
  organization_id uuid not null,
  kind text not null,
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create table journal.finalizations (
  id uuid primary key references journal.entries(id),
  outcome text not null check(outcome in ('COMMITTED','ABORTED')),
  created_at timestamptz not null default clock_timestamp()
);
alter table journal.entries owner to fichaje_archive_writer;
alter table journal.finalizations owner to fichaje_archive_writer;
alter sequence journal.entries_ordinal_seq owner to fichaje_archive_writer;
alter table journal.entries enable row level security;
alter table journal.entries force row level security;
alter table journal.finalizations enable row level security;
alter table journal.finalizations force row level security;

create policy append_only on journal.entries for insert to fichaje_archive_writer with check(true);
create policy verifier_read on journal.entries for select to fichaje_archive_writer using(true);
create policy verifier_read on journal.finalizations for select to fichaje_archive_writer using(true);

create function journal.prepare(p_id uuid,p_source uuid,p_xid text,p_org uuid,p_kind text,p_payload jsonb)
returns boolean language plpgsql security definer set search_path='' as \$\$
begin
  if p_kind not in ('HOLD','IDENTITY_STATE','ORGANIZATION_STATE','PURGE') then
    raise exception 'INVALID_JOURNAL_KIND';
  end if;
  insert into journal.entries(id,source_id,transaction_id,organization_id,kind,payload)
  values(p_id,p_source,p_xid,p_org,p_kind,p_payload);
  return true;
end \$\$;
alter function journal.prepare(uuid,uuid,text,uuid,text,jsonb) owner to fichaje_archive_writer;
revoke all on function journal.prepare(uuid,uuid,text,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function journal.prepare(uuid,uuid,text,uuid,text,jsonb) to fichaje_archive_connection;

create function journal.verify(p_id uuid,p_source uuid,p_org uuid,p_kind text,p_payload jsonb)
returns boolean language sql stable security definer set search_path='' as \$\$
  select exists(
    select 1 from journal.entries e
    join journal.finalizations f on f.id=e.id
    where e.id=p_id and e.source_id=p_source and e.organization_id=p_org
      and e.kind=p_kind and e.payload=p_payload and f.outcome='COMMITTED'
  )
\$\$;
alter function journal.verify(uuid,uuid,uuid,text,jsonb) owner to fichaje_archive_writer;
revoke all on function journal.verify(uuid,uuid,uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function journal.verify(uuid,uuid,uuid,text,jsonb) to fichaje_archive_connection;

create function journal.immutable() returns trigger language plpgsql security definer set search_path='' as \$\$
begin
  raise exception 'IMMUTABLE_JOURNAL';
end \$\$;
alter function journal.immutable() owner to fichaje_archive_writer;
revoke all on function journal.immutable() from public,anon,authenticated,service_role;
create trigger immutable before update or delete or truncate on journal.entries
  for each statement execute function journal.immutable();
create trigger immutable before update or delete or truncate on journal.finalizations
  for each statement execute function journal.immutable();

revoke create on schema journal from fichaje_archive_writer;
grant connect on database postgres to fichaje_archive_connection;
commit;
SQL
created_archive=1

archive_shape="$(psql "$staging_conn" -XAtq -v ON_ERROR_STOP=1 -c "
select
  (exists(select 1 from pg_roles where rolname='fichaje_archive_connection')
   and exists(select 1 from pg_roles where rolname='fichaje_archive_writer')
   and to_regclass('journal.entries') is not null
   and to_regclass('journal.finalizations') is not null
   and to_regprocedure('journal.prepare(uuid,uuid,text,uuid,text,jsonb)') is not null
   and to_regprocedure('journal.verify(uuid,uuid,uuid,text,jsonb)') is not null)::int;")"
[[ "$archive_shape" == "1" ]] || failed 'archive verification failed'

# dblink_fdw is already present because the application migration enabled dblink.
psql "$production_conn" -Xq -v ON_ERROR_STOP=1 <<SQL
begin;
create server fichaje_recovery foreign data wrapper dblink_fdw
  options (
    host '$STAGING_DB_HOST',
    port '$DB_PORT',
    dbname '$DB_NAME',
    sslmode 'verify-full',
    sslrootcert 'system'
  );
create user mapping for fichaje_journal server fichaje_recovery
  options (user 'fichaje_archive_connection', password '$archive_password');
grant usage on foreign server fichaje_recovery to fichaje_journal;
commit;
SQL
created_link=1

# End-to-end, read-only validation through the same SECURITY DEFINER path used
# by recovery. A random missing entry must verify false; no archive row is added.
verify_result="$(psql "$production_conn" -XAtq -v ON_ERROR_STOP=1 -c "
select private.verify_journal_entry(gen_random_uuid(),gen_random_uuid(),'PURGE','{}'::jsonb);")"   || failed 'journal TLS/credential/function validation failed'
[[ "$verify_result" == "f" ]] || failed 'unexpected journal verification result'

complete=1
printf 'GO-LIVE recovery journal: PASS (TLS verify-full, least-privilege link, no tenant data written)\n'

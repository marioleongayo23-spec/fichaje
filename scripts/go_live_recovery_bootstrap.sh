#!/usr/bin/env bash
# GO-LIVE zero-cost recovery bootstrap.
# Secrets are entered/generated locally and never printed or committed.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE="${FICHAJE_GO_LIVE_STATE:-$HOME/.fichaje-go-live}"
SECRETS="$STATE/secrets"
BACKUPS="$STATE/db-backups"
TMP="$STATE/tmp"
STAGING_REF="pvfjffeszsedslmwdvgh"
PRODUCTION_REF="bypdviatamosygndeqhh"
REGION="eu-west-1"
mkdir -p "$SECRETS" "$BACKUPS" "$TMP"
chmod 700 "$STATE" "$SECRETS" "$BACKUPS" "$TMP"

blocked(){ printf 'BLOCKED: %s\n' "$1" >&2; exit 2; }
cleanup(){
  unset STAGING_ADMIN_PASSWORD PRODUCTION_ADMIN_PASSWORD ARCHIVE_PASSWORD BACKUP_STAGING_PASSWORD BACKUP_PRODUCTION_PASSWORD
  [[ -n ${WORK:-} ]] && rm -rf "$WORK"
}
trap cleanup EXIT
for tool in psql pg_dump pg_restore age age-keygen openssl python3; do
  command -v "$tool" >/dev/null || blocked "$tool is required"
done
command -v security >/dev/null || blocked 'macOS Keychain (security command) is required for age private-key custody'

printf 'Supabase staging database password (hidden): '
IFS= read -rs STAGING_ADMIN_PASSWORD; printf '\n'
printf 'Supabase production-candidate database password (hidden): '
IFS= read -rs PRODUCTION_ADMIN_PASSWORD; printf '\n'
[[ -n $STAGING_ADMIN_PASSWORD && -n $PRODUCTION_ADMIN_PASSWORD ]] || blocked 'both database passwords are required'

WORK="$(mktemp -d "$TMP/bootstrap-XXXXXX")"
ADMIN_PGPASS="$WORK/admin.pgpass"
touch "$ADMIN_PGPASS"; chmod 600 "$ADMIN_PGPASS"

probe_pooler(){
  local ref="$1" password="$2" host
  for host in "${FICHAJE_POOLER_HOST:-}" "aws-0-$REGION.pooler.supabase.com" "aws-1-$REGION.pooler.supabase.com"; do
    [[ -n $host ]] || continue
    printf '%s:5432:postgres:postgres.%s:%s\n' "$host" "$ref" "$password" > "$ADMIN_PGPASS"
    if PGPASSFILE="$ADMIN_PGPASS" psql "host=$host port=5432 dbname=postgres user=postgres.$ref sslmode=verify-full sslrootcert=system connect_timeout=8" -XAtq -v ON_ERROR_STOP=1 -c 'select 1' >/dev/null 2>&1; then
      printf '%s' "$host"; return 0
    fi
  done
  return 1
}
STAGING_HOST="$(probe_pooler "$STAGING_REF" "$STAGING_ADMIN_PASSWORD")" || blocked 'cannot reach staging with the supplied database password'
PRODUCTION_HOST="$(probe_pooler "$PRODUCTION_REF" "$PRODUCTION_ADMIN_PASSWORD")" || blocked 'cannot reach production candidate with the supplied database password'

staging_psql(){
  printf '%s:5432:postgres:postgres.%s:%s\n' "$STAGING_HOST" "$STAGING_REF" "$STAGING_ADMIN_PASSWORD" > "$ADMIN_PGPASS"
  PGPASSFILE="$ADMIN_PGPASS" psql "host=$STAGING_HOST port=5432 dbname=postgres user=postgres.$STAGING_REF sslmode=verify-full sslrootcert=system connect_timeout=10" -X -v ON_ERROR_STOP=1 "$@"
}
production_psql(){
  printf '%s:5432:postgres:postgres.%s:%s\n' "$PRODUCTION_HOST" "$PRODUCTION_REF" "$PRODUCTION_ADMIN_PASSWORD" > "$ADMIN_PGPASS"
  PGPASSFILE="$ADMIN_PGPASS" psql "host=$PRODUCTION_HOST port=5432 dbname=postgres user=postgres.$PRODUCTION_REF sslmode=verify-full sslrootcert=system connect_timeout=10" -X -v ON_ERROR_STOP=1 "$@"
}

ARCHIVE_PASSWORD="$(openssl rand -hex 32)"
BACKUP_STAGING_PASSWORD="$(openssl rand -hex 32)"
BACKUP_PRODUCTION_PASSWORD="$(openssl rand -hex 32)"

# Keep the recovery private key only in Keychain. The backup host retains the public recipient.
AGE_SERVICE='fichaje-go-live-age-identity'
if AGE_SECRET="$(security find-generic-password -a "$USER" -s "$AGE_SERVICE" -w 2>/dev/null)"; then
  printf '%s\n' "$AGE_SECRET" > "$WORK/age-identity.txt"
else
  age-keygen -o "$WORK/age-full.txt" >/dev/null 2>&1
  AGE_SECRET="$(grep '^AGE-SECRET-KEY-' "$WORK/age-full.txt" | head -1)"
  [[ $AGE_SECRET == AGE-SECRET-KEY-* ]] || blocked 'age identity generation failed'
  security add-generic-password -U -a "$USER" -s "$AGE_SERVICE" -w "$AGE_SECRET" >/dev/null
  printf '%s\n' "$AGE_SECRET" > "$WORK/age-identity.txt"
fi
chmod 600 "$WORK/age-identity.txt"
AGE_RECIPIENT="$(age-keygen -y "$WORK/age-identity.txt")"
[[ $AGE_RECIPIENT == age1* ]] || blocked 'age recipient derivation failed'
printf '%s\n' "$AGE_RECIPIENT" > "$STATE/age-recipient.txt"
chmod 600 "$STATE/age-recipient.txt"

# 1) Archive in the independent staging project. Password appears only in this owner-only temp SQL file.
ARCHIVE_SQL="$WORK/archive.sql"; chmod 600 "$ARCHIVE_SQL"
cat > "$ARCHIVE_SQL" <<SQL
set password_encryption='scram-sha-256';
do \$bootstrap\$
begin
  if not exists(select 1 from pg_roles where rolname='fichaje_archive_connection') then
    create role fichaje_archive_connection nologin noinherit;
  end if;
  if not exists(select 1 from pg_roles where rolname='fichaje_archive_writer') then
    create role fichaje_archive_writer nologin noinherit nobypassrls;
  end if;
end \$bootstrap\$;
grant fichaje_archive_writer to postgres;
alter role fichaje_archive_connection login noinherit valid until 'infinity' password '$ARCHIVE_PASSWORD';
SQL
staging_psql -f "$ARCHIVE_SQL" >/dev/null
if [[ "$(staging_psql -XAtq -c "select to_regnamespace('journal') is not null")" != t ]]; then
  python3 - "$ROOT" > "$WORK/archive-schema.sql" <<'PY'
import sys
sys.path.insert(0, sys.argv[1] + '/scripts')
from recovery_archive import ARCHIVE_SCHEMA
print(ARCHIVE_SCHEMA.replace('database fichaje_recovery', 'database postgres'))
PY
  chmod 600 "$WORK/archive-schema.sql"
  staging_psql -f "$WORK/archive-schema.sql" >/dev/null
fi

# 2) Production -> independent archive, fail closed. Recreate only this environment-specific server/mapping.
WIRE_SQL="$WORK/wire.sql"; chmod 600 "$WIRE_SQL"
cat > "$WIRE_SQL" <<SQL
drop user mapping if exists for fichaje_journal server fichaje_recovery;
drop server if exists fichaje_recovery cascade;
create server fichaje_recovery foreign data wrapper dblink_fdw
  options(host '$STAGING_HOST',port '5432',dbname 'postgres',sslmode 'verify-full',sslrootcert 'system');
grant usage on foreign server fichaje_recovery to fichaje_journal;
create user mapping for fichaje_journal server fichaje_recovery
  options(user 'fichaje_archive_connection.$STAGING_REF',password '$ARCHIVE_PASSWORD');
SQL
production_psql -f "$WIRE_SQL" >/dev/null
JOURNAL_TEST="$(production_psql -XAtq -c "begin; set local role fichaje_retention_operator; select private.verify_journal_entry(gen_random_uuid(),gen_random_uuid(),'PURGE','{}'::jsonb); rollback")" || blocked 'journal dblink test failed'
[[ $JOURNAL_TEST == f ]] || blocked 'journal verification returned an unexpected result'

# 3) Dedicated read-only backup logins in staging and production.
make_backup_role(){
  local which="$1" password="$2" sql="$WORK/backup-$which.sql"
  chmod 600 "$sql"
  cat > "$sql" <<SQL
set password_encryption='scram-sha-256';
do \$bootstrap\$
begin
  if not exists(select 1 from pg_roles where rolname='fichaje_backup') then
    create role fichaje_backup nologin noinherit;
  end if;
end \$bootstrap\$;
alter role fichaje_backup login bypassrls connection limit 2 valid until 'infinity' password '$password';
grant pg_read_all_data to fichaje_backup;
alter role fichaje_backup set default_transaction_read_only=on;
SQL
  if [[ $which == staging ]]; then staging_psql -f "$sql" >/dev/null; else production_psql -f "$sql" >/dev/null; fi
}
make_backup_role staging "$BACKUP_STAGING_PASSWORD"
make_backup_role production "$BACKUP_PRODUCTION_PASSWORD"

PGSERVICEFILE="$SECRETS/pg_service.conf"
PGPASSFILE="$SECRETS/pgpass"
cat > "$PGSERVICEFILE" <<EOF
[fichaje_backup_staging]
host=$STAGING_HOST
port=5432
dbname=postgres
user=fichaje_backup.$STAGING_REF
sslmode=verify-full
sslrootcert=system
connect_timeout=15

[fichaje_backup_production]
host=$PRODUCTION_HOST
port=5432
dbname=postgres
user=fichaje_backup.$PRODUCTION_REF
sslmode=verify-full
sslrootcert=system
connect_timeout=15
EOF
cat > "$PGPASSFILE" <<EOF
$STAGING_HOST:5432:postgres:fichaje_backup.$STAGING_REF:$BACKUP_STAGING_PASSWORD
$PRODUCTION_HOST:5432:postgres:fichaje_backup.$PRODUCTION_REF:$BACKUP_PRODUCTION_PASSWORD
EOF
chmod 600 "$PGSERVICEFILE" "$PGPASSFILE"

for service in fichaje_backup_staging fichaje_backup_production; do
  [[ "$(PGSERVICEFILE="$PGSERVICEFILE" PGPASSFILE="$PGPASSFILE" psql "service=$service" -XAtq -v ON_ERROR_STOP=1 -c "show transaction_read_only")" == on ]] ||
    blocked "$service is not read-only"
done

# 4) First real encrypted backup: remote staging contains synthetic data only.
PGSERVICEFILE="$PGSERVICEFILE" PGPASSFILE="$PGPASSFILE" \
FICHAJE_BACKUP_PGSERVICE=fichaje_backup_staging \
FICHAJE_BACKUP_CA=system \
FICHAJE_BACKUP_AGE_RECIPIENT="$AGE_RECIPIENT" \
FICHAJE_BACKUP_DEST="$BACKUPS" \
FICHAJE_BACKUP_MIN_FREE_MB=256 \
bash "$ROOT/scripts/backup_database.sh" >/dev/null

# No passwords or private identity are printed.
printf 'PASS: recovery journal wired; backup logins read-only; encrypted staging backup created.\n'
printf 'State directory: %s\n' "$STATE"
printf 'Next: run scripts/go_live_restore_drill.sh to restore this exact encrypted backup into a disposable local Supabase.\n'

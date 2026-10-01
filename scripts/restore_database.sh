#!/usr/bin/env bash
# H7 isolated restore of an encrypted PostgreSQL backup (docs/RECOVERY.md).
#
#   restore_database.sh <backup-directory> <backup-name>
#
# 1. Manifest and SHA-256 of the ciphertext are verified before any decryption.
# 2. The target must be an empty, isolated environment whose migrations are
#    exactly the backup's (schema, functions, triggers and RLS come from the
#    restored repository; the backup only carries data).
# 3. age decrypts in a stream into pg_restore, whose SQL goes straight into one
#    psql transaction with triggers suspended (session_replication_role =
#    replica). COMMIT is emitted only if decryption and pg_restore both ended
#    well and no foreign key is left dangling; otherwise the transaction is
#    rolled back and the target stays empty. No plaintext touches the disk.
# 4. The recovery journal is replayed separately (scripts/recovery_journal.py)
#    before any access is reopened; this script never reopens anything.
#
# Required environment:
#   FICHAJE_RESTORE_PGSERVICE    target service in PGSERVICEFILE (PGPASSFILE for the password; both 0600)
#   FICHAJE_RESTORE_CA           PEM CA of the target (sslmode=verify-full)
#   FICHAJE_RESTORE_IDENTITY     age identity file (0600), kept outside the backup destination
#   FICHAJE_RESTORE_CONFIRM      must equal the target database name (explicit consent)
# Optional: FICHAJE_RESTORE_RESULT (JSON result file for backup_monitor.py).
set -euo pipefail
umask 077

blocked() { printf 'BLOCKED: restore refused: %s\n' "$1" >&2; exit 2; }
failed() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }
owner_only() { [[ -f $1 && ! -L $1 && $(stat -c '%a %u' -- "$1") == "600 $(id -u)" ]]; }

[[ $# -eq 2 ]] || blocked 'usage: restore_database.sh <backup-directory> <backup-name>'
source_dir=$(cd "$1" 2>/dev/null && pwd -P) || blocked 'backup directory not found'
name=$2
[[ $name =~ ^fichaje-db-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$ ]] || blocked 'invalid backup name'
for variable in FICHAJE_RESTORE_PGSERVICE PGSERVICEFILE PGPASSFILE FICHAJE_RESTORE_CA FICHAJE_RESTORE_IDENTITY FICHAJE_RESTORE_CONFIRM; do
  [[ -n ${!variable:-} ]] || blocked "$variable is not configured"
done
owner_only "$PGSERVICEFILE" && owner_only "$PGPASSFILE" || blocked 'PGSERVICEFILE and PGPASSFILE must be owner-only (0600) files'
owner_only "$FICHAJE_RESTORE_IDENTITY" || blocked 'the age identity must be an owner-only (0600) file'
identity=$(cd "$(dirname "$FICHAJE_RESTORE_IDENTITY")" && pwd -P)/$(basename "$FICHAJE_RESTORE_IDENTITY")
[[ $identity != "$source_dir"/* ]] || blocked 'the private key is stored next to the backup'
grep -q 'BEGIN CERTIFICATE' "$FICHAJE_RESTORE_CA" 2>/dev/null || blocked 'FICHAJE_RESTORE_CA is not a PEM certificate'
for tool in age pg_restore psql sha256sum; do command -v "$tool" >/dev/null || blocked "$tool is not installed"; done
cipher="$source_dir/$name.dump.age"
manifest="$source_dir/$name.manifest.json"
[[ -f $cipher && -f $manifest && -f $cipher.sha256 ]] || blocked 'backup files missing (ciphertext, checksum or manifest)'
field() { sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"?([^\",}]*)\"?.*/\1/p" "$manifest"; }
[[ $(field schema) == fichaje.db-backup.v1 && $(field result) == success && $(field encrypted) == true ]] || blocked 'manifest is not a successful encrypted backup'
(cd "$source_dir" && sha256sum --status -c -- "$name.dump.age.sha256") || failed 'CHECKSUM_MISMATCH (ciphertext altered or incomplete; nothing decrypted)'
[[ $(sha256sum -- "$cipher" | cut -d' ' -f1) == "$(field ciphertext_sha256)" ]] || failed 'CHECKSUM_MISMATCH (manifest)'

conninfo="service=$FICHAJE_RESTORE_PGSERVICE sslmode=verify-full sslrootcert=$FICHAJE_RESTORE_CA application_name=fichaje-restore connect_timeout=15"
psql_q() { psql "$conninfo" -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
target_db=$(psql_q 'select current_database()') || failed 'CONNECTION_FAILED (TLS verify-full, credentials or network)'
[[ $target_db == "$FICHAJE_RESTORE_CONFIRM" ]] || blocked 'FICHAJE_RESTORE_CONFIRM does not name the target database'
[[ $(psql_q 'select (select count(*) from public.organizations) + (select count(*) from auth.users)') == 0 ]] \
  || blocked 'target is not empty (restore only into a fresh, isolated environment)'
expected=$(field migration_version)
actual=$(psql_q "select coalesce(max(version),'') from supabase_migrations.schema_migrations")
[[ -n $expected && $actual == "$expected" ]] || blocked "target schema version differs from the backup (apply the same migrations first)"
# Key check first: decrypt to nowhere. Without the right identity nothing is restored.
age --decrypt --identity "$FICHAJE_RESTORE_IDENTITY" -- "$cipher" > /dev/null 2>&1 || failed 'DECRYPTION_FAILED (wrong or missing private key; nothing restored)'

tables=$(psql_q "select string_agg(format('%I.%I',schemaname,tablename),', ' order by schemaname,tablename) from pg_tables
  where schemaname in ('public','private') and tablename not in ('mutation_context','recovery_replay_context','retention_delete_guard','ops_repair_context')")
# Any dangling foreign key left by the data load aborts the transaction.
fk_check="do \$fk\$ declare c record; n bigint; begin
  for c in select conrelid::regclass as child, confrelid::regclass as parent, conname,
      (select string_agg(format('%I',a.attname),',' order by k.i) from unnest(conkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=conrelid and a.attnum=k.n) as cols,
      (select string_agg(format('%I',a.attname),',' order by k.i) from unnest(confkey) with ordinality k(n,i) join pg_attribute a on a.attrelid=confrelid and a.attnum=k.n) as pcols
    from pg_constraint where contype='f' and connamespace in ('public'::regnamespace,'private'::regnamespace)
  loop
    execute format('select count(*) from %s t where (%s) is not null and not exists (select 1 from %s p where (%s) = (%s))',
      c.child, (select string_agg('t.'||x, ',') from unnest(string_to_array(c.cols, ',')) x), c.parent,
      (select string_agg('p.'||x, ',') from unnest(string_to_array(c.pcols, ',')) x),
      (select string_agg('t.'||x, ',') from unnest(string_to_array(c.cols, ',')) x)) into n;
    if n > 0 then raise exception 'RESTORE_DANGLING_FOREIGN_KEY %', c.conname; end if;
  end loop; end \$fk\$;"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
set +e
{
  printf '%s\n' '\set ON_ERROR_STOP on' 'BEGIN;' 'SET LOCAL session_replication_role = replica;' 'SET LOCAL statement_timeout = 0;'
  [[ -n $tables ]] && printf 'TRUNCATE %s;\n' "$tables"
  if age --decrypt --identity "$FICHAJE_RESTORE_IDENTITY" -- "$cipher" 2>/dev/null \
      | pg_restore --data-only --no-owner --no-acl --file=- 2>/dev/null; then
    printf '%s\n' 'SET LOCAL session_replication_role = origin;' "$fk_check" 'COMMIT;'
  else
    printf '%s\n' 'ROLLBACK;'
  fi
} | psql "$conninfo" -Xq -v ON_ERROR_STOP=1 >/dev/null 2>&1
statuses=("${PIPESTATUS[@]}")
set -e
[[ ${statuses[1]} -eq 0 ]] || failed 'RESTORE_FAILED (transaction rolled back)'
# The load really committed only if the tenant data is visible now.
[[ $(psql_q 'select count(*) > 0 from public.organizations') == t ]] || failed 'RESTORE_FAILED (decryption or dump error; transaction rolled back)'
completed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [[ -n ${FICHAJE_RESTORE_RESULT:-} ]]; then
  printf '{"schema":"fichaje.db-restore.v1","backup":"%s","result":"success","started_at":"%s","completed_at":"%s","migration_version":"%s","checks":["checksum","key","empty_target","schema_version","single_transaction","foreign_keys"]}\n' \
    "$name" "$started" "$completed" "$expected" > "$FICHAJE_RESTORE_RESULT"
fi
printf 'Restored into an isolated target (journal replay and validation pending): %s\n' "$name"

#!/usr/bin/env bash
# H7 encrypted PostgreSQL backup. Fails closed (exit 2, "BLOCKED") unless every
# precondition of docs/RECOVERY.md holds; never writes, logs or uploads a
# plaintext dump. Pipeline (one stream, pipefail):
#
#   pg_dump --format=custom --data-only  (public.*, private.* without the
#           transaction-bound context tables, auth.users, auth.identities)
#     | age --encrypt --recipient <age1… public key>
#     → work/<name>.dump.age.partial → age header check → SHA-256
#     → private destination (copy, re-hash, rename) → manifest last.
#
# A checksum of the ciphertext is NOT a restore test: backup_monitor.py only
# reports OK once scripts/restore_database.sh restored this very backup.
#
# Required environment (names only; values come from the operator's custody):
#   FICHAJE_BACKUP_PGSERVICE      service name in PGSERVICEFILE (host, port, dbname, user)
#   PGSERVICEFILE, PGPASSFILE     owner-only files (0600) outside the repository
#   FICHAJE_BACKUP_CA             PEM CA certificate; the connection is sslmode=verify-full
#   FICHAJE_BACKUP_AGE_RECIPIENT  age public key; the private key never reaches this host
#   FICHAJE_BACKUP_DEST           private destination: directory (0700) or rclone:<remote:path>
# Optional: FICHAJE_BACKUP_WORKDIR (private temporary directory),
#           FICHAJE_BACKUP_MIN_FREE_MB (default 1024), RCLONE_CONFIG (rclone destination).
set -euo pipefail
umask 077

blocked() { printf 'BLOCKED: database backup disabled: %s\n' "$1" >&2; exit 2; }
failed() { printf 'FAILED: %s\n' "$1" >&2; exit 1; }
stat_mode_uid() {
  if stat -c '%a %u' "$1" >/dev/null 2>&1; then stat -c '%a %u' "$1"
  else stat -f '%Lp %u' "$1" 2>/dev/null
  fi
}
stat_bytes() {
  if stat -c '%s' "$1" >/dev/null 2>&1; then stat -c '%s' "$1"
  else stat -f '%z' "$1"
  fi
}
sha256_file() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'
  else blocked 'sha256sum or shasum is not installed'
  fi
}
sha256_stdin() {
  if command -v sha256sum >/dev/null; then sha256sum | awk '{print $1}'
  elif command -v shasum >/dev/null; then shasum -a 256 | awk '{print $1}'
  else blocked 'sha256sum or shasum is not installed'
  fi
}
owner_only() { [[ -f $1 && ! -L $1 && $(stat_mode_uid "$1") == "600 $(id -u)" ]]; }

[[ $# -eq 0 ]] || blocked 'no arguments are accepted'
for name in FICHAJE_BACKUP_PGSERVICE PGSERVICEFILE PGPASSFILE FICHAJE_BACKUP_CA FICHAJE_BACKUP_AGE_RECIPIENT FICHAJE_BACKUP_DEST; do
  [[ -n ${!name:-} ]] || blocked "$name is not configured"
done
# The private key must be in independent custody: its presence here is a stop.
if env | grep -q 'AGE-SECRET-KEY-1'; then blocked 'an age private key is present in the environment'; fi
recipient=$FICHAJE_BACKUP_AGE_RECIPIENT
[[ $recipient =~ ^age1[02-9ac-hj-np-z]{58}$ ]] || blocked 'FICHAJE_BACKUP_AGE_RECIPIENT is not an age public key'
[[ $FICHAJE_BACKUP_PGSERVICE =~ ^[A-Za-z0-9_-]{1,64}$ ]] || blocked 'invalid service name'
owner_only "$PGSERVICEFILE" || blocked 'PGSERVICEFILE must be an owner-only (0600) regular file'
owner_only "$PGPASSFILE" || blocked 'PGPASSFILE must be an owner-only (0600) regular file'
grep -q "^\[$FICHAJE_BACKUP_PGSERVICE\]" "$PGSERVICEFILE" || blocked 'service not defined in PGSERVICEFILE'
if grep -qiE '^[[:space:]]*password[[:space:]]*=' "$PGSERVICEFILE"; then blocked 'passwords belong in PGPASSFILE, not in PGSERVICEFILE'; fi
ca=$FICHAJE_BACKUP_CA
if [[ $ca == system ]]; then
  :
else
  [[ -f $ca && -r $ca ]] && grep -q 'BEGIN CERTIFICATE' "$ca" || blocked 'FICHAJE_BACKUP_CA must be system or a readable PEM certificate'
  if grep -q 'PRIVATE KEY' "$ca"; then blocked 'FICHAJE_BACKUP_CA contains a private key'; fi
fi
for tool in pg_dump psql age; do
  command -v "$tool" >/dev/null || blocked "$tool is not installed"
done
command -v sha256sum >/dev/null || command -v shasum >/dev/null || blocked 'sha256sum or shasum is not installed'
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || true)
dest=$FICHAJE_BACKUP_DEST
if [[ $dest == rclone:* ]]; then
  command -v rclone >/dev/null || blocked 'rclone is not installed'
  owner_only "${RCLONE_CONFIG:-/nonexistent}" || blocked 'RCLONE_CONFIG must be an owner-only (0600) file'
  remote=${dest#rclone:}
else
  [[ -d $dest && ! -L $dest && $(stat_mode_uid "$dest") == "700 $(id -u)" ]] || blocked 'destination must be an owner-only (0700) directory'
  dest=$(cd "$dest" && pwd -P)
  if [[ -n $repo && ( $dest == "$repo" || $dest == "$repo"/* ) ]]; then blocked 'destination is inside the Git working tree'; fi
  if grep -rlq 'AGE-SECRET-KEY-1' "$dest" 2>/dev/null; then blocked 'an age private key is stored in the destination'; fi
fi
work_base=${FICHAJE_BACKUP_WORKDIR:-${TMPDIR:-/tmp}}
[[ -d $work_base ]] || blocked 'work directory does not exist'
free_mb=$(df -Pm "$work_base" | awk 'NR==2 {print $4}')
(( free_mb >= ${FICHAJE_BACKUP_MIN_FREE_MB:-1024} )) || blocked 'not enough free space in the work directory'

# Explicit connection parameters win over anything in the service file.
conninfo="service=$FICHAJE_BACKUP_PGSERVICE sslmode=verify-full sslrootcert=$ca application_name=fichaje-backup connect_timeout=15"
work=$(mktemp -d "$work_base/fichaje-db-XXXXXX")
name=''
cleanup() {
  rm -rf "$work"
  if [[ -n $name && $dest != rclone:* ]]; then rm -f "$dest/$name".*.partial; fi
}
trap cleanup EXIT

client=$(pg_dump --version | grep -oE '[0-9]+(\.[0-9]+)?' | head -1)
server=$(psql "$conninfo" -XAtq -c 'show server_version_num' 2>"$work/connect.err") || failed 'CONNECTION_FAILED (TLS verify-full, credentials or network)'
(( ${client%%.*} >= server / 10000 )) || blocked "pg_dump $client is older than the server"
migration=$(psql "$conninfo" -XAtq -c "select coalesce((select max(version) from supabase_migrations.schema_migrations),'') where to_regclass('supabase_migrations.schema_migrations') is not null" 2>/dev/null || true)
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
snapshot=$(psql "$conninfo" -XAtq -c "select to_char(now() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')") || failed 'CONNECTION_FAILED'
name="fichaje-db-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
cipher="$work/$name.dump.age.partial"

set +e
pg_dump "$conninfo" --format=custom --data-only --no-owner --no-acl --no-comments --no-publications --no-subscriptions \
  --no-security-labels --table='public.*' --table='private.*' --table=auth.users --table=auth.identities \
  --exclude-table=private.mutation_context --exclude-table=private.recovery_replay_context \
  --exclude-table=private.retention_delete_guard --exclude-table=private.ops_repair_context 2>"$work/pg_dump.err" \
  | age --encrypt --recipient "$recipient" --output "$cipher" 2>"$work/age.err"
statuses=("${PIPESTATUS[@]}")
set -e
# A failed encryption also breaks pg_dump's pipe (SIGPIPE): report it first.
[[ ${statuses[1]} -eq 0 ]] || failed 'ENCRYPTION_FAILED (no backup produced)'
[[ ${statuses[0]} -eq 0 ]] || failed 'PG_DUMP_FAILED (no backup produced)'
[[ -s $cipher && $(head -c 21 "$cipher") == 'age-encryption.org/v1' ]] || failed 'CIPHERTEXT_INVALID'
if head -c 4096 "$cipher" | grep -aq 'PGDMP'; then failed 'CIPHERTEXT_INVALID'; fi
completed=$(date -u +%Y-%m-%dT%H:%M:%SZ)
digest=$(sha256_file "$cipher")
bytes=$(stat_bytes "$cipher")
mv "$cipher" "$work/$name.dump.age"
printf '%s  %s\n' "$digest" "$name.dump.age" > "$work/$name.dump.age.sha256"
recipient_digest=$(printf '%s' "$recipient" | sha256_stdin)
cat > "$work/$name.manifest.json" <<EOF
{"schema":"fichaje.db-backup.v1","result":"success","name":"$name","started_at":"$started","snapshot_not_before":"$snapshot","completed_at":"$completed","encrypted":true,"encryption":"age-x25519","recipient_sha256":"$recipient_digest","ciphertext":"$name.dump.age","ciphertext_sha256":"$digest","ciphertext_bytes":$bytes,"pg_dump_version":"$client","server_version_num":"$server","migration_version":"$migration","format":"custom","content":"data-only","tables":"public.*,private.* (without transaction-bound contexts),auth.users,auth.identities","tls":"verify-full","restore_test":null}
EOF

# Upload: ciphertext and checksum first, verified; the manifest is the commit marker.
if [[ $dest == rclone:* ]]; then
  for file in "$name.dump.age" "$name.dump.age.sha256" "$name.manifest.json"; do
    rclone copyto "$work/$file" "${remote%/}/$file" --config "$RCLONE_CONFIG" --immutable || failed 'UPLOAD_FAILED'
    rclone check "$work" "${remote%/}" --config "$RCLONE_CONFIG" --one-way --download --include "$file" >/dev/null 2>&1 || failed 'UPLOAD_UNVERIFIED'
  done
else
  for file in "$name.dump.age" "$name.dump.age.sha256"; do
    cp "$work/$file" "$dest/$file.partial"
    [[ $(sha256_file "$dest/$file.partial") == $(sha256_file "$work/$file") ]] || failed 'UPLOAD_UNVERIFIED'
    mv "$dest/$file.partial" "$dest/$file"
  done
  cp "$work/$name.manifest.json" "$dest/$name.manifest.json.partial"
  mv "$dest/$name.manifest.json.partial" "$dest/$name.manifest.json"
fi
printf 'Backup encrypted and verified: %s\n' "$name"

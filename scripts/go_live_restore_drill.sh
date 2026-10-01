#!/usr/bin/env bash
# Restore the exact remote encrypted GO-LIVE backup into a disposable local Supabase.
set -euo pipefail
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
STATE="${FICHAJE_GO_LIVE_STATE:-$HOME/.fichaje-go-live}"
BACKUPS="$STATE/db-backups"
TMP="$STATE/tmp"
AGE_SERVICE='fichaje-go-live-age-identity'
mkdir -p "$TMP"; chmod 700 "$STATE" "$TMP" 2>/dev/null || true

blocked(){ printf 'BLOCKED: %s\n' "$1" >&2; exit 2; }
STARTED=0
cleanup(){
  if [[ $STARTED -eq 1 && -n ${WORK:-} ]]; then
    supabase stop --no-backup --workdir "$WORK/repo" >/dev/null 2>&1 || true
  fi
  [[ -n ${WORK:-} ]] && rm -rf "$WORK"
}
trap cleanup EXIT
for tool in docker supabase openssl psql pg_restore age security git python3; do
  command -v "$tool" >/dev/null || blocked "$tool is required"
done
docker info >/dev/null 2>&1 || blocked 'Docker is not running'
[[ -d $BACKUPS ]] || blocked 'run scripts/go_live_recovery_bootstrap.sh first'
manifest="$(find "$BACKUPS" -maxdepth 1 -type f -name 'fichaje-db-*.manifest.json' -print | sort | tail -1)"
[[ -n $manifest ]] || blocked 'no encrypted GO-LIVE database backup found'
name="$(basename "$manifest" .manifest.json)"

WORK="$(mktemp -d "$TMP/restore-XXXXXX")"
mkdir -p "$WORK/repo" "$WORK/custody"
chmod 700 "$WORK" "$WORK/repo" "$WORK/custody"

# The private identity is materialized only in the isolated temp custody directory.
AGE_SECRET="$(security find-generic-password -a "$USER" -s "$AGE_SERVICE" -w 2>/dev/null)" || blocked 'age private identity is not available in Keychain'
[[ $AGE_SECRET == AGE-SECRET-KEY-* ]] || blocked 'invalid age identity in Keychain'
printf '%s\n' "$AGE_SECRET" > "$WORK/custody/identity.txt"
chmod 600 "$WORK/custody/identity.txt"
unset AGE_SECRET

# Restore from the exact current checkout without altering the user's working tree.
git -C "$ROOT" archive HEAD | tar -x -C "$WORK/repo"
python3 - "$WORK/repo/supabase/config.toml" <<'PY'
import pathlib, sys
p=pathlib.Path(sys.argv[1])
s=p.read_text()
s=s.replace('project_id = "fichaje-h1"', 'project_id = "fichaje-go-live-restore"')
s=s.replace('port = 54321', 'port = 55321', 1)
s=s.replace('port = 54322', 'port = 55322', 1)
s=s.replace('shadow_port = 54320', 'shadow_port = 55320', 1)
s=s.replace('port = 54324', 'port = 55324', 1)
p.write_text(s)
PY

supabase start -x studio,realtime,imgproxy,edge-runtime,logflare,vector,supavisor --workdir "$WORK/repo" >/dev/null
STARTED=1
DB_CONTAINER='supabase_db_fichaje-go-live-restore'

# Enable TLS on the disposable database so the production restore path still uses verify-full.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=Fichaje GO-LIVE restore CA' \
  -keyout "$WORK/custody/ca.key" -out "$WORK/custody/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj '/CN=localhost' \
  -keyout "$WORK/custody/server.key" -out "$WORK/custody/server.csr" >/dev/null 2>&1
cat > "$WORK/custody/san.ext" <<EOF
subjectAltName=DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF
openssl x509 -req -in "$WORK/custody/server.csr" -CA "$WORK/custody/ca.crt" -CAkey "$WORK/custody/ca.key" \
  -CAcreateserial -days 1 -extfile "$WORK/custody/san.ext" -out "$WORK/custody/server.crt" >/dev/null 2>&1
docker exec -u root "$DB_CONTAINER" mkdir -p /etc/ssl/fichaje-go-live
for f in ca.crt server.crt server.key; do docker cp "$WORK/custody/$f" "$DB_CONTAINER:/etc/ssl/fichaje-go-live/$f" >/dev/null; done
docker exec -u root "$DB_CONTAINER" sh -c 'chown postgres:postgres /etc/ssl/fichaje-go-live/* && chmod 644 /etc/ssl/fichaje-go-live/ca.crt /etc/ssl/fichaje-go-live/server.crt && chmod 600 /etc/ssl/fichaje-go-live/server.key'
docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 -Xq <<'SQL'
alter system set ssl='on';
alter system set ssl_cert_file='/etc/ssl/fichaje-go-live/server.crt';
alter system set ssl_key_file='/etc/ssl/fichaje-go-live/server.key';
select pg_reload_conf();
SQL
for _ in $(seq 1 30); do
  [[ "$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -Atq -c 'show ssl')" == on ]] && break
  sleep 1
done
[[ "$(docker exec "$DB_CONTAINER" psql -U supabase_admin -d postgres -Atq -c 'show ssl')" == on ]] || blocked 'could not enable TLS on disposable restore target'

PGSERVICEFILE="$WORK/custody/pg_service.conf"
PGPASSFILE="$WORK/custody/pgpass"
cat > "$PGSERVICEFILE" <<EOF
[fichaje_restore]
host=localhost
hostaddr=127.0.0.1
port=55322
dbname=postgres
user=postgres
sslmode=verify-full
sslrootcert=$WORK/custody/ca.crt
connect_timeout=10
EOF
printf '127.0.0.1:55322:postgres:postgres:postgres\n' > "$PGPASSFILE"
chmod 600 "$PGSERVICEFILE" "$PGPASSFILE"

result="$BACKUPS/$name.restore.json"
PGSERVICEFILE="$PGSERVICEFILE" PGPASSFILE="$PGPASSFILE" \
FICHAJE_RESTORE_PGSERVICE=fichaje_restore \
FICHAJE_RESTORE_CA="$WORK/custody/ca.crt" \
FICHAJE_RESTORE_IDENTITY="$WORK/custody/identity.txt" \
FICHAJE_RESTORE_CONFIRM=postgres \
FICHAJE_RESTORE_RESULT="$result" \
bash "$ROOT/scripts/restore_database.sh" "$BACKUPS" "$name" >/dev/null

conn="host=localhost hostaddr=127.0.0.1 port=55322 dbname=postgres user=postgres sslmode=verify-full sslrootcert=$WORK/custody/ca.crt"
q(){ PGPASSWORD=postgres psql "$conn" -XAtq -v ON_ERROR_STOP=1 -c "$1"; }
[[ "$(q 'select count(*) > 0 from public.organizations')" == t ]] || blocked 'restored backup has no organizations'
[[ "$(q 'select count(*) > 0 from public.time_events')" == t ]] || blocked 'restored backup has no time events'
[[ "$(q 'select count(*) > 0 from auth.users')" == t ]] || blocked 'restored backup has no Auth users'
[[ "$(q "select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'")" == t ]] ||
  blocked 'RLS is not enabled on every restored public table'
[[ "$(q "select exists(select 1 from pg_trigger where tgrelid='public.time_events'::regclass and not tgisinternal)")" == t ]] ||
  blocked 'time event immutability trigger is missing after restore'

printf 'PASS: exact remote encrypted backup restored into disposable TLS-enabled Supabase and validated.\n'
printf 'Restore evidence: %s\n' "$result"

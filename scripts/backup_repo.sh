#!/usr/bin/env bash
set -euo pipefail
umask 077
fail() { printf '%s\n' "$1" >&2; exit 1; }
root=$(git rev-parse --show-toplevel) || exit 1
cd "$root"
[[ $(git rev-parse --is-shallow-repository) == false ]] || fail 'Refusing shallow history; fetch complete history first.'
[[ -z $(git status --porcelain) ]] || fail 'Refusing dirty repository; commit or isolate changes first.'
# Snapshot = tracked HEAD. Bundle = all locally available refs; workflow fetches every origin branch/tag.
[[ $# -le 1 ]] || fail 'Usage: backup_repo.sh [output-directory]'
out=${1:-"$root/backups"}
mkdir -p "$out"
out=$(cd "$out" && pwd)
if [[ ${BACKUP_UPLOAD_DRIVE:-0} != 0 && ${BACKUP_UPLOAD_DRIVE:-0} != 1 ]]; then
  fail 'BACKUP_UPLOAD_DRIVE must be 0 or 1.'
fi
if [[ ${BACKUP_UPLOAD_DRIVE:-0} == 1 ]]; then
  [[ -n ${RCLONE_CONFIG:-} && -f "$RCLONE_CONFIG" && -n ${RCLONE_DESTINATION:-} ]] || fail 'Drive upload requires external rclone config and destination.'
  command -v rclone >/dev/null || fail 'rclone is required for upload.'
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
sha=$(git rev-parse HEAD)
run=$(mktemp -d "$out/repo-$stamp-${sha:0:12}-XXXXXX")
cleanup() { if [[ -n ${run:-} ]]; then rm -rf -- "$run"; fi; }
trap cleanup EXIT
bundle="$run/repository.bundle"
git bundle create "$bundle" --all
git bundle verify "$bundle" >/dev/null
git archive --format=tar --prefix=fichaje/ HEAD | gzip -n > "$run/snapshot.tar.gz"
printf 'commit=%s\ncreated_utc=%s\nsnapshot=tracked HEAD only\nbundle=all fetched refs\n' "$sha" "$stamp" > "$run/manifest.txt"
git for-each-ref --format='%(objectname) %(refname)' > "$run/refs.txt"
(cd "$run" && sha256sum repository.bundle snapshot.tar.gz manifest.txt refs.txt > SHA256SUMS)
if [[ ${BACKUP_UPLOAD_DRIVE:-0} == 1 ]]; then
  destination="${RCLONE_DESTINATION%/}/$(basename "$run")"
  # copy, never sync/delete. Config is outside git and contains all credentials.
  rclone copy "$run" "$destination" --config "$RCLONE_CONFIG" --immutable
  rclone check "$run" "$destination" --config "$RCLONE_CONFIG" --one-way --download
fi
printf 'Backup verified: %s\n' "$run"
run='' # retain only a completely successful backup

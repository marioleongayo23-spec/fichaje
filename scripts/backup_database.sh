#!/usr/bin/env bash
set -euo pipefail
# HARD GATE H0. No environment variable can enable this script.
# Future reviewed implementation must:
# 1. Use a dedicated read-only backup connection from Actions Secrets, TLS verify-full.
# 2. Check pg_dump version, pg_service/pgpass file modes, age recipient and available disk.
# 3. Stream pg_dump --format=custom --no-owner --no-acl directly into age encryption.
#    Use pipefail + temporary ciphertext; never create or upload a plaintext dump.
# 4. Verify ciphertext and checksum, then rclone copy/check to a private destination.
# 5. Restore in an isolated matching Supabase environment (Auth/Storage/roles separately).
# 6. Record RPO/RTO, retention and independent key custody before activation.
printf '%s\n' 'BLOCKED: database backup is disabled in HITO 0. Connection, encryption and restore approval required.' >&2
exit 2

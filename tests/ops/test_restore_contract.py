"""H8 regression tests for the isolated restore shell contract.

The commands are harmless stubs: no database or plaintext backup is used.
"""
from __future__ import annotations

import hashlib
import json
import os
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / 'scripts' / 'restore_database.sh'
NAME = 'fichaje-db-20261001T120000Z-deadbeef'
MIGRATION = '20260930000200'


class RestoreContractTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='fichaje-h8-restore-')
        self.root = Path(self.tmp.name)
        self.bin = self.root / 'bin'
        self.backup = self.root / 'backup'
        self.bin.mkdir()
        self.backup.mkdir(mode=0o700)
        self.identity = self.root / 'identity.txt'
        self.identity.write_text('AGE-SECRET-KEY-1' + 'Q' * 58)
        self.identity.chmod(0o600)
        self.service = self.root / 'pg_service.conf'
        self.service.write_text('[restore]\nhost=db.synthetic.invalid\ndbname=postgres\nuser=restore\n')
        self.service.chmod(0o600)
        self.pgpass = self.root / 'pgpass'
        self.pgpass.write_text('db.synthetic.invalid:5432:postgres:restore:synthetic\n')
        self.pgpass.chmod(0o600)
        self.ca = self.root / 'ca.crt'
        self.ca.write_text('-----BEGIN CERTIFICATE-----\nsynthetic\n-----END CERTIFICATE-----\n')
        self.capture = self.root / 'transaction.sql'

        cipher = self.backup / f'{NAME}.dump.age'
        cipher.write_bytes(b'age-encryption.org/v1\nsynthetic-ciphertext\n')
        digest = hashlib.sha256(cipher.read_bytes()).hexdigest()
        (self.backup / f'{NAME}.dump.age.sha256').write_text(f'{digest}  {NAME}.dump.age\n')
        (self.backup / f'{NAME}.manifest.json').write_text(json.dumps({
            'schema': 'fichaje.db-backup.v1',
            'result': 'success',
            'encrypted': True,
            'ciphertext_sha256': digest,
            'migration_version': MIGRATION,
        }, separators=(',', ':')))

        self._stub('age', '''
if [[ "$1" != "--decrypt" ]]; then exit 90; fi
last=""
for last; do :; done
cat "$last"
''')
        self._stub('pg_restore', '''
cat >/dev/null
if [[ -n "$H8_FAIL_PG_RESTORE" ]]; then exit 9; fi
printf 'SELECT 1;\\n'
''')
        self._stub('psql', '''
args="$*"
is_command=0
for arg in "$@"; do
  if [[ "$arg" == "-c" ]]; then is_command=1; break; fi
done
if [[ "$is_command" == 1 ]]; then
  if [[ "$args" == *"current_database()"* ]]; then printf 'postgres\\n'
  elif [[ "$args" == *"public.organizations"*"auth.users"* ]]; then printf '0\\n'
  elif [[ "$args" == *"schema_migrations"* ]]; then printf '%s\\n' "$H8_MIGRATION"
  elif [[ "$args" == *"string_agg"* ]]; then printf '\\n'
  elif [[ "$args" == *"count(*) > 0 from public.organizations"* ]]; then printf '%s\\n' "$H8_OLD_ORG_RESULT"
  elif [[ "$args" == *"select 1"* ]]; then printf '1\\n'
  else printf '\\n'
  fi
  exit 0
fi
payload="$(cat)"
printf '%s' "$payload" > "$H8_PSQL_CAPTURE"
first="$(printf '%s\n' "$payload" | head -n 1)"
if [[ "$first" != '\\set ON_ERROR_STOP on' ]]; then exit 88; fi
exit 0
''')

    def tearDown(self):
        self.tmp.cleanup()

    def _stub(self, name: str, body: str):
        path = self.bin / name
        path.write_text('#!/usr/bin/env bash\nset -euo pipefail\n' + body.strip() + '\n')
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def _run(self, **extra):
        env = {
            **os.environ,
            'PATH': f'{self.bin}:{os.environ["PATH"]}',
            'FICHAJE_RESTORE_PGSERVICE': 'restore',
            'PGSERVICEFILE': str(self.service),
            'PGPASSFILE': str(self.pgpass),
            'FICHAJE_RESTORE_CA': str(self.ca),
            'FICHAJE_RESTORE_IDENTITY': str(self.identity),
            'FICHAJE_RESTORE_CONFIRM': 'postgres',
            'H8_MIGRATION': MIGRATION,
            'H8_PSQL_CAPTURE': str(self.capture),
            'H8_FAIL_PG_RESTORE': '',
            'H8_OLD_ORG_RESULT': 'f',
            **extra,
        }
        return subprocess.run(['bash', str(SCRIPT), str(self.backup), NAME], env=env, text=True,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)

    def test_valid_restore_with_zero_organizations_succeeds(self):
        result = self._run(H8_OLD_ORG_RESULT='f')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('Restored into an isolated target', result.stdout)
        transaction = self.capture.read_text()
        self.assertIn('BEGIN;', transaction)
        self.assertIn('COMMIT;', transaction)
        self.assertNotIn('ROLLBACK;', transaction)

    def test_pg_restore_failure_cannot_be_reported_as_success(self):
        result = self._run(H8_FAIL_PG_RESTORE='1', H8_OLD_ORG_RESULT='t')
        self.assertEqual(result.returncode, 1)
        self.assertIn('RESTORE_FAILED', result.stderr)
        self.assertIn('ROLLBACK;', self.capture.read_text())
        self.assertNotIn('COMMIT;', self.capture.read_text())


if __name__ == '__main__':
    unittest.main()

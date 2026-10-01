"""H7/H8 guards: synthetic provisioning is allowed only on loopback or on an
explicitly pinned staging/production API + database pair."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'ops'))
import canary  # noqa: E402

STAGING_API = 'abcdefghijklmnopqrst.supabase.co'
STAGING_DB = 'db.abcdefghijklmnopqrst.supabase.co'
PRODUCTION_API = 'zyxwvutsrqponmlkjihg.supabase.co'
PRODUCTION_DB = 'db.zyxwvutsrqponmlkjihg.supabase.co'
STAGING_DSN = f'host={STAGING_DB} dbname=postgres user=postgres sslmode=verify-full sslrootcert=/custody/ca.crt'
PRODUCTION_DSN = f'host={PRODUCTION_DB} dbname=postgres user=postgres sslmode=verify-full sslrootcert=/custody/ca.crt'


class H8ProvisioningGuard(unittest.TestCase):
    def pins(self, environment: str) -> dict[str, str]:
        return {
            'FICHAJE_ENV': environment,
            'FICHAJE_STAGING_API_HOST': STAGING_API,
            'FICHAJE_STAGING_DB_HOST': STAGING_DB,
            'FICHAJE_PRODUCTION_API_HOST': PRODUCTION_API,
            'FICHAJE_PRODUCTION_DB_HOST': PRODUCTION_DB,
        }

    def test_loopback_keeps_ci_behaviour(self):
        self.assertTrue(canary.Provisioner.allowed('http://127.0.0.1:54321', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'))
        self.assertFalse(canary.Provisioner.allowed('http://127.0.0.1:54321', STAGING_DSN))

    def test_staging_requires_api_and_database_pins_https_and_verify_full(self):
        with mock.patch.dict(os.environ, self.pins('staging'), clear=True):
            self.assertTrue(canary.Provisioner.allowed(f'https://{STAGING_API}', STAGING_DSN))
            self.assertFalse(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', STAGING_DSN), 'another API project')
            self.assertFalse(canary.Provisioner.allowed(f'https://{STAGING_API}', PRODUCTION_DSN), 'another database project')
            self.assertFalse(canary.Provisioner.allowed(f'http://{STAGING_API}', STAGING_DSN), 'no API TLS')
            self.assertFalse(canary.Provisioner.allowed(f'https://{STAGING_API}', STAGING_DSN.replace('verify-full', 'require')), 'weak DB TLS')

    def test_production_is_allowed_only_with_the_production_pair(self):
        with mock.patch.dict(os.environ, self.pins('production'), clear=True):
            self.assertTrue(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', PRODUCTION_DSN))
            self.assertFalse(canary.Provisioner.allowed(f'https://{STAGING_API}', PRODUCTION_DSN), 'staging API')
            self.assertFalse(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', STAGING_DSN), 'staging DB')

    def test_uri_dsn_is_parsed_and_pinned(self):
        uri = f'postgresql://operator:secret@{PRODUCTION_DB}:5432/postgres?sslmode=verify-full'
        with mock.patch.dict(os.environ, self.pins('production'), clear=True):
            self.assertTrue(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', uri))
            self.assertFalse(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', uri.replace(PRODUCTION_DB, STAGING_DB)))
            self.assertFalse(canary.Provisioner.allowed(
                f'https://{PRODUCTION_API}',
                uri + f'&host={STAGING_DB}'), 'URI query host must not override the pinned authority')
            self.assertFalse(canary.Provisioner.allowed(
                f'https://{PRODUCTION_API}',
                uri.replace('?sslmode=', '?sslmode=verify-full&sslmode=')), 'duplicate sslmode must fail closed')
            self.assertFalse(canary.Provisioner.allowed(
                f'https://{PRODUCTION_API}',
                uri.replace(':5432/', ':6543/')), 'nonstandard target port')

    def test_keyword_dsn_rejects_alternate_target_controls(self):
        with mock.patch.dict(os.environ, self.pins('production'), clear=True):
            self.assertFalse(canary.Provisioner.allowed(
                f'https://{PRODUCTION_API}', PRODUCTION_DSN + f' hostaddr=192.0.2.5'))
            self.assertFalse(canary.Provisioner.allowed(
                f'https://{PRODUCTION_API}', PRODUCTION_DSN + ' service=other'))
            self.assertFalse(canary.Provisioner.allowed(
                f'https://{PRODUCTION_API}', PRODUCTION_DSN + f' host={STAGING_DB}'))

    def test_missing_or_opaque_remote_pins_fail_closed(self):
        with mock.patch.dict(os.environ, {'FICHAJE_ENV': 'production', 'FICHAJE_PRODUCTION_API_HOST': PRODUCTION_API}, clear=True):
            self.assertFalse(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', PRODUCTION_DSN), 'DB pin missing')
            self.assertFalse(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', 'service=fichaje sslmode=verify-full'), 'opaque service target')
        with mock.patch.dict(os.environ, {'FICHAJE_ENV': 'other'}, clear=True):
            self.assertFalse(canary.Provisioner.allowed(f'https://{PRODUCTION_API}', PRODUCTION_DSN))


if __name__ == '__main__':
    unittest.main()

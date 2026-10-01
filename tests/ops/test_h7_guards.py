"""H7 guards: synthetic provisioning never targets anything but loopback or the
explicitly pinned staging project (never production)."""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'ops'))
import canary  # noqa: E402

STAGING = 'abcdefghijklmnopqrst.supabase.co'
DSN = 'host=db.abcdefghijklmnopqrst.supabase.co dbname=postgres user=postgres sslmode=verify-full sslrootcert=/custody/ca.crt'


class H7ProvisioningGuard(unittest.TestCase):
    def test_loopback_keeps_the_ci_behaviour(self):
        self.assertTrue(canary.Provisioner.allowed('http://127.0.0.1:54321', 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'))
        self.assertFalse(canary.Provisioner.allowed('http://127.0.0.1:54321', DSN))

    def test_staging_requires_explicit_environment_pinned_host_https_and_verify_full(self):
        with mock.patch.dict(os.environ, {'FICHAJE_ENV': 'staging', 'FICHAJE_STAGING_API_HOST': STAGING}):
            self.assertTrue(canary.Provisioner.allowed(f'https://{STAGING}', DSN))
            self.assertFalse(canary.Provisioner.allowed('https://zyxwvutsrqponmlkjihg.supabase.co', DSN), 'another project')
            self.assertFalse(canary.Provisioner.allowed(f'http://{STAGING}', DSN), 'no TLS')
            self.assertFalse(canary.Provisioner.allowed(f'https://{STAGING}', DSN.replace('verify-full', 'require')), 'weak TLS')
        with mock.patch.dict(os.environ, {'FICHAJE_ENV': 'production', 'FICHAJE_STAGING_API_HOST': STAGING}):
            self.assertFalse(canary.Provisioner.allowed(f'https://{STAGING}', DSN), 'production is never a target')
        with mock.patch.dict(os.environ, {'FICHAJE_ENV': 'staging'}, clear=False):
            os.environ.pop('FICHAJE_STAGING_API_HOST', None)
            self.assertFalse(canary.Provisioner.allowed(f'https://{STAGING}', DSN), 'host must be pinned')


if __name__ == '__main__':
    unittest.main()

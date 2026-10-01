"""H8 production verifier target guard."""
from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('verify_production', ROOT / 'scripts' / 'production' / 'verify_production.py')
assert SPEC and SPEC.loader
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)

APP = 'fichaje.example.com'
API = 'zyxwvutsrqponmlkjihg.supabase.co'


class ProductionVerifyGuardTest(unittest.TestCase):
    def env(self):
        return {
            'FICHAJE_ENV': 'production',
            'FICHAJE_PRODUCTION_APP_HOST': APP,
            'FICHAJE_PRODUCTION_API_HOST': API,
            'FICHAJE_STAGING_APP_HOST': 'fichaje-staging.pages.dev',
            'FICHAJE_STAGING_API_HOST': 'abcdefghijklmnopqrst.supabase.co',
        }

    def test_exact_production_pair_is_allowed(self):
        with mock.patch.dict(os.environ, self.env(), clear=True):
            self.assertTrue(verify.allowed(f'https://{APP}', f'https://{API}'))

    def test_staging_or_unpinned_targets_are_rejected(self):
        with mock.patch.dict(os.environ, self.env(), clear=True):
            self.assertFalse(verify.allowed('https://fichaje-staging.pages.dev', f'https://{API}'))
            self.assertFalse(verify.allowed(f'https://{APP}', 'https://abcdefghijklmnopqrst.supabase.co'))
            self.assertFalse(verify.allowed(f'http://{APP}', f'https://{API}'))
            self.assertFalse(verify.allowed(f'https://{APP}/path', f'https://{API}'))
        with mock.patch.dict(os.environ, {'FICHAJE_ENV': 'production'}, clear=True):
            self.assertFalse(verify.allowed(f'https://{APP}', f'https://{API}'))

    def test_staging_environment_cannot_run_production_verifier(self):
        env = self.env()
        env['FICHAJE_ENV'] = 'staging'
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertFalse(verify.allowed(f'https://{APP}', f'https://{API}'))


if __name__ == '__main__':
    unittest.main()

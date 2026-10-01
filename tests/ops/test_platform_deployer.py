"""H7 PlatformDeployer (Cloudflare Pages Direct Upload + Supabase Edge Functions)
with a recording runner instead of the platform CLIs: exact commands, least
credentials per command, nothing secret in argv or state, fail-closed
configuration and rollback through the same immutable path. The real run
against staging is an operator step (docs/STAGING.md)."""
import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'ops'))
import deployers  # noqa: E402
import opslib  # noqa: E402
import release_gate  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CREDS = {'CLOUDFLARE_API_TOKEN': 'cf-synthetic-token-' + 'x' * 20, 'CLOUDFLARE_ACCOUNT_ID': 'a' * 32,
         'SUPABASE_ACCESS_TOKEN': 'sbp_' + 'y' * 40}
COMMIT = 'c' * 40


class Recorder:
    def __init__(self, fail_step: str | None = None):
        self.calls, self.fail_step = [], fail_step

    def __call__(self, command, cwd, env, stdout, stderr, check):
        self.calls.append({'command': list(command), 'cwd': str(cwd), 'env': dict(env)})
        if command[:3] == ['npm', 'run', 'build']:
            out = Path(command[command.index('--outDir') + 1])
            (out / 'assets').mkdir(parents=True)
            (out / 'index.html').write_text('<div id="root"></div>')
            (out / '_headers').write_text('/*\n')
        failed = self.fail_step and any(self.fail_step in part for part in command)
        return mock.Mock(returncode=1 if failed else 0)


class H7PlatformDeployer(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        opslib.LOG.path = str(self.tmp / 'events.jsonl')
        self.env = mock.patch.dict(os.environ, CREDS)
        self.env.start()
        self.live = mock.patch.object(deployers, 'http_raw', return_value=(200, b'', {}))
        self.live.start()

    def tearDown(self):
        self.live.stop()
        self.env.stop()
        opslib.LOG.path = None

    def deployer(self, runner):
        return deployers.PlatformDeployer(self.tmp / 'work', 'staging', 'fichaje-staging', 'abcdefghijklmnopqrst', 'https://staging.example.test',
                                          {'VITE_SUPABASE_URL': 'https://abcdefghijklmnopqrst.supabase.co', 'VITE_SUPABASE_PUBLISHABLE_KEY': 'sb_publishable_x'},
                                          runner=runner)

    def test_build_and_deploy_commands_use_least_credentials(self):
        runner = Recorder()
        d = self.deployer(runner)
        target = d.build('h7-r1', COMMIT)
        manifest = json.loads((target / 'release.json').read_text())
        self.assertIn('pages/functions/gateway/[[path]].ts', manifest['files'])
        self.assertIn('pages/edge/gateway.ts', manifest['files'])
        self.assertIn('pages/supabase/functions/_shared/ingress.ts', manifest['files'])
        self.assertIn('supabase/functions/kiosk/index.ts', manifest['files'])
        self.assertFalse(any(name.endswith('_test.ts') for name in manifest['files']))
        live = d.deploy('h7-r1')
        self.assertTrue(all(live.values()))
        commands = [c['command'] for c in runner.calls]
        self.assertEqual(commands[1], ['supabase', 'secrets', 'set', '--project-ref', 'abcdefghijklmnopqrst', 'FICHAJE_RELEASE=h7-r1', f'FICHAJE_COMMIT={COMMIT}'])
        self.assertEqual(commands[2], ['supabase', 'functions', 'deploy', 'kiosk', '--project-ref', 'abcdefghijklmnopqrst', '--no-verify-jwt', '--use-api',
                                       '--workdir', str(target)])
        self.assertEqual(commands[3][3], 'export-link')
        self.assertEqual(commands[4][:6], ['wrangler', 'pages', 'deploy', str(target / 'dist'), '--project-name', 'fichaje-staging'])
        self.assertIn('--branch', commands[4])
        self.assertEqual(commands[4][commands[4].index('--branch') + 1], 'staging')
        self.assertEqual(runner.calls[4]['cwd'], str(target / 'pages'), 'wrangler compiles the release copy of functions/')
        for call in runner.calls:
            flat = ' '.join(call['command'])
            for value in CREDS.values():
                self.assertNotIn(value, flat, 'a credential never appears in argv')
        supabase_env = runner.calls[2]['env']
        wrangler_env = runner.calls[4]['env']
        self.assertIn('SUPABASE_ACCESS_TOKEN', supabase_env)
        self.assertNotIn('CLOUDFLARE_API_TOKEN', supabase_env)
        self.assertIn('CLOUDFLARE_API_TOKEN', wrangler_env)
        self.assertNotIn('SUPABASE_ACCESS_TOKEN', wrangler_env)
        self.assertNotIn('SUPABASE_ACCESS_TOKEN', runner.calls[0]['env'], 'the build never sees platform credentials')
        state = (self.tmp / 'work' / 'release-state.json')
        self.assertEqual(stat.S_IMODE(state.stat().st_mode), 0o600)
        for log in (self.tmp / 'work' / 'logs').iterdir():
            self.assertEqual(stat.S_IMODE(log.stat().st_mode), 0o600)
        events = (self.tmp / 'events.jsonl').read_text()
        for value in CREDS.values():
            self.assertNotIn(value, events)

    def test_failed_platform_step_is_a_failed_deploy_and_rollback_uses_the_same_path(self):
        runner = Recorder()
        d = self.deployer(runner)
        d.build('h7-r1', COMMIT)
        d.build('h7-r2', 'd' * 40)
        verdicts = {'h7-r1': 'PASS', 'h7-r2': 'FAIL'}
        gate = lambda rid: {'release_id': rid, 'status': verdicts[rid], 'health': {'status': 'UP', 'checks': {}},  # noqa: E731
                            'canary': {'status': verdicts[rid], 'channels': {}}, 'synthetic': {'status': 'PASS', 'checks': {}}}
        engine = mock.Mock(process=mock.Mock(return_value=[]))
        self.assertEqual(release_gate.promote(d, 'h7-r1', gate, engine)['state'], 'PROMOTED')
        outcome = release_gate.promote(d, 'h7-r2', gate, engine)
        self.assertEqual((outcome['state'], outcome['current']), ('ROLLED_BACK', 'h7-r1'))
        pages = [c['command'][3] for c in runner.calls if c['command'][:3] == ['wrangler', 'pages', 'deploy']]
        self.assertEqual(pages, [str(d.path('h7-r1') / 'dist'), str(d.path('h7-r2') / 'dist'), str(d.path('h7-r1') / 'dist')],
                         'rollback redeploys the previous healthy immutable artifact')
        broken = self.deployer(Recorder(fail_step='export-link'))
        broken.build('h7-r3', COMMIT)
        self.assertEqual(broken.deploy('h7-r3'), {'app': False, 'kiosk': False, 'export_link': False})

    def test_configuration_fails_closed_before_any_command(self):
        runner = Recorder()
        with mock.patch.dict(os.environ, {'SUPABASE_ACCESS_TOKEN': ''}):
            with self.assertRaises(opslib.OpsError):
                self.deployer(runner)
        bad = [('production-x', 'fichaje', 'abcdefghijklmnopqrst', 'https://x.test'), ('staging', 'Bad_Name', 'abcdefghijklmnopqrst', 'https://x.test'),
               ('staging', 'fichaje', 'short', 'https://x.test'), ('staging', 'fichaje', 'abcdefghijklmnopqrst', 'http://x.test')]
        for environment, project, ref, url in bad:
            with self.assertRaises(opslib.OpsError):
                deployers.PlatformDeployer(self.tmp / 'w', environment, project, ref, url,
                                           {'VITE_SUPABASE_URL': 'https://r.supabase.co', 'VITE_SUPABASE_PUBLISHABLE_KEY': 'p'}, runner=runner)
        with self.assertRaises(opslib.OpsError):
            deployers.PlatformDeployer(self.tmp / 'w', 'staging', 'fichaje', 'abcdefghijklmnopqrst', 'https://x.test',
                                       {'VITE_SUPABASE_URL': 'http://127.0.0.1:54321', 'VITE_SUPABASE_PUBLISHABLE_KEY': 'p'}, runner=runner)
        d = self.deployer(runner)
        with self.assertRaises(opslib.OpsError):
            d.build('h7-r1', 'not-a-sha')
        self.assertEqual(runner.calls, [])


if __name__ == '__main__':
    unittest.main()

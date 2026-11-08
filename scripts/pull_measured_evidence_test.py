# SPDX-License-Identifier: LicenseRef-Proprietary
"""Exercise artifact selection and refusal before any evidence store write."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


class PullMeasuredEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = {"databaseId": 123, "headSha": "a" * 40, "headBranch": "dev", "event": "push"}
        self.data = {"commit": self.run["headSha"], "run_at": datetime.now(timezone.utc).isoformat(),
                     "source_command": "proof", "rows": [{"status": "fail"}, {"status": "unknown"}]}
        (self.root / "evidence.py").write_text('''import json, os, sys
from pathlib import Path
def validate(data, name):
    if data.get('invalid'): raise ValueError('invalid row')
if __name__ == '__main__':
    data = json.loads(Path(sys.argv[2]).read_text())
    with Path(os.environ['INGEST_LOG']).open('a') as log:
        log.write(json.dumps([Path(sys.argv[2]).name, data]) + '\\n')
''')
        (self.root / "gh").write_text(f'''#!{sys.executable}
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
assert args[args.index('--repo') + 1] == 'sample/console' if '--repo' in args else True
if args[:2] == ['run', 'list']:
    assert '--status' in args and args[args.index('--status') + 1] == 'completed'
    assert args[args.index('--workflow') + 1] == 'ci.yml'
    print(os.environ['RUN'])
elif args[0] == 'api':
    print(json.dumps([{{'artifacts': [{{'name': name}} for name in json.loads(os.environ['ARTIFACTS'])]}}]))
elif args[:2] == ['run', 'download']:
    assert args[2] == '123'
    artifact = args[args.index('--name') + 1]
    assert artifact in json.loads(os.environ['ARTIFACTS'])
    Path(args[args.index('--dir') + 1]).mkdir()
    names = ('e2e', 'nextest') if artifact == 'd7-evidence' else ('states',)
    for name in names:
        data = json.loads(os.environ['DATA'])
        if name == os.environ.get('INVALID_SOURCE'): data['invalid'] = True
        (Path(args[args.index('--dir') + 1]) / (name + '.json')).write_text(json.dumps(data))
else: sys.exit('unexpected gh invocation: ' + repr(args))
''')
        (self.root / "gh").chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                    "INGEST_LOG": str(self.root / "ingested"), "ARTIFACTS": json.dumps(["states-evidence", "d7-evidence"])}

    def invoke(self):
        self.env.update(RUN=json.dumps([self.run] if self.run else []), DATA=json.dumps(self.data))
        return subprocess.run(["bash", "scripts/pull-measured-evidence.sh", str(self.root), "sample/console"],
                              env=self.env, capture_output=True, text=True)

    def test_latest_set_keeps_failed_and_unknown_rows(self):
        for artifact in ("states-evidence", "d8-evidence"):
            with self.subTest(artifact=artifact):
                self.env['ARTIFACTS'] = json.dumps([artifact, "d7-evidence"])
                result = self.invoke()
                self.assertEqual(result.returncode, 0, result.stderr)
                records = [json.loads(line) for line in (self.root / "ingested").read_text().splitlines()]
                self.assertEqual([name for name, _ in records], ["states.json", "e2e.json", "nextest.json"])
                self.assertTrue(all(data == self.data for _, data in records))
                (self.root / "ingested").unlink()

    def test_untrusted_stale_or_incomplete_set_never_writes(self):
        original_run, original_data = self.run.copy(), self.data.copy()
        cases = (('branch', 'dev push'), ('event', 'dev push'), ('commit', 'commit differs'),
                 ('stale', 'stale'), ('invalid', 'invalid row'), ('missing', 'states artifact'), ('empty', 'completed dev'))
        for case, message in cases:
            with self.subTest(case=case):
                self.run, self.data = original_run.copy(), original_data.copy()
                self.env['ARTIFACTS'] = json.dumps(["states-evidence", "d7-evidence"])
                self.env.pop('INVALID_SOURCE', None)
                if case == 'branch': self.run['headBranch'] = 'feature'
                if case == 'event': self.run['event'] = 'pull_request'
                if case == 'commit': self.data['commit'] = 'b' * 40
                if case == 'stale': self.data['run_at'] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
                if case == 'invalid': self.env['INVALID_SOURCE'] = 'nextest'
                if case == 'missing': self.env['ARTIFACTS'] = json.dumps(["d7-evidence"])
                if case == 'empty': self.run = None
                result = self.invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.root / "ingested").exists())

    def test_states_publish_is_independent_of_backend_changes(self):
        source = Path('.github/workflows/ci.yml').read_text()
        job = source.split('\n  states-timings:\n', 1)[1].split('\n  backend:\n', 1)[0]
        self.assertNotIn("outputs.backend", job)
        self.assertIn('python3 scripts/states-evidence.py', job)
        self.assertIn('name: states-evidence', job)
        self.assertIn('.cache/states-plan/modules.json', job)


if __name__ == '__main__': unittest.main()

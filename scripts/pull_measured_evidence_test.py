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


RELEASE_JOB = "Collect release test evidence"


class PullMeasuredEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.run = {"databaseId": 123, "headSha": "a" * 40, "headBranch": "dev", "event": "push", "status": "completed"}
        self.jobs = {RELEASE_JOB: "success"}
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
runs = json.loads(os.environ['RUNS'])
run_ids = [str(run['databaseId']) for run in runs]
assert args[args.index('--repo') + 1] == 'sample/console' if '--repo' in args else True
if args[:2] == ['run', 'list']:
    assert args[args.index('--workflow') + 1] == 'ci.yml'
    if '--status' in args: runs = []
    limit = int(args[args.index('--limit') + 1]) if '--limit' in args else 20
    fields = args[args.index('--json') + 1].split(',')
    print(json.dumps([{{key: run[key] for key in fields}} for run in runs[:limit]]))
elif args[0] == 'api':
    assert '--paginate' in args and '--slurp' in args
    run_path, resource = args[1].rsplit('/', 1)
    assert run_path in ['repos/sample/console/actions/runs/' + run_id for run_id in run_ids]
    if resource == 'jobs':
        print(json.dumps([{{'jobs': [{{'name': name, 'conclusion': conclusion}}]}}
                          for name, conclusion in json.loads(os.environ['JOBS']).items()]))
    else:
        assert resource == 'artifacts'
        print(json.dumps([{{'artifacts': [{{'name': name}} for name in json.loads(os.environ['ARTIFACTS'])]}}]))
elif args[:2] == ['run', 'download']:
    assert args[2] in run_ids
    with Path(__file__).with_name('downloads').open('a') as log:
        print(args[2], file=log)
    artifact = args[args.index('--name') + 1]
    assert artifact in json.loads(os.environ['ARTIFACTS'])
    Path(args[args.index('--dir') + 1]).mkdir()
    names = ('e2e', 'nextest') if artifact == 'd7-evidence' else (artifact.removesuffix('-evidence'),)
    for name in names:
        data = json.loads(os.environ['DATA'])
        if name == os.environ.get('INVALID_SOURCE'): data['invalid'] = True
        if artifact in json.loads(os.environ.get('INVALID_ARTIFACTS', '[]')): data['invalid'] = True
        (Path(args[args.index('--dir') + 1]) / (name + '.json')).write_text(json.dumps(data))
else: sys.exit('unexpected gh invocation: ' + repr(args))
''')
        (self.root / "gh").chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                    "INGEST_LOG": str(self.root / "ingested"), "ARTIFACTS": json.dumps(["d7-evidence"])}

    def invoke(self, runs=None):
        if runs is None: runs = [self.run] if self.run else []
        self.env.update(RUNS=json.dumps(runs), DATA=json.dumps(self.data), JOBS=json.dumps(self.jobs))
        return subprocess.run(["bash", "scripts/pull-measured-evidence.sh", str(self.root), "sample/console"],
                              env=self.env, capture_output=True, text=True)

    def test_newest_completed_run_supplies_failed_and_unknown_rows(self):
        runs = [dict(self.run, databaseId=124, status="in_progress"), self.run, dict(self.run, databaseId=122)]
        result = self.invoke(runs)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / "downloads").read_text().splitlines(), [str(self.run["databaseId"])])
        records = [json.loads(line) for line in (self.root / "ingested").read_text().splitlines()]
        self.assertEqual([name for name, _ in records], ["e2e.json", "nextest.json"])
        self.assertTrue(all(data == self.data for _, data in records))

    def test_available_sources_ingest_independently_without_older_run_fallback(self):
        for sources in (("e2e",), ("nextest",), ("e2e", "nextest")):
            with self.subTest(sources=sources):
                self.env['ARTIFACTS'] = json.dumps([name + "-evidence" for name in sources])
                result = self.invoke()
                self.assertEqual(result.returncode, 0, result.stderr)
                records = [json.loads(line) for line in (self.root / "ingested").read_text().splitlines()]
                self.assertEqual([name for name, _ in records], [name + ".json" for name in sources])
                self.assertTrue(all(data == self.data for _, data in records))
                (self.root / "ingested").unlink()

    def test_available_invalid_source_never_partially_ingests(self):
        self.env.update(ARTIFACTS=json.dumps(["e2e-evidence", "nextest-evidence"]), INVALID_SOURCE="nextest")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid row", result.stderr)
        self.assertFalse((self.root / "ingested").exists())

    def test_unsuccessful_or_missing_producer_never_ingests(self):
        for conclusion in ("failure", "cancelled", "timed_out", "action_required", "neutral", None, "missing"):
            with self.subTest(conclusion=conclusion):
                self.jobs = {} if conclusion == "missing" else {RELEASE_JOB: conclusion}
                result = self.invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("producer release-evidence", result.stderr)
                self.assertFalse((self.root / "ingested").exists())

    def test_skipped_release_without_artifacts_never_ingests(self):
        self.jobs[RELEASE_JOB] = "skipped"
        self.env['ARTIFACTS'] = '[]'
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no measured artifacts", result.stderr)
        self.assertFalse((self.root / "ingested").exists())

    def test_successful_web_only_run_allows_missing_nextest(self):
        self.env['ARTIFACTS'] = json.dumps(["e2e-evidence"])
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        records = [json.loads(line) for line in (self.root / "ingested").read_text().splitlines()]
        self.assertEqual([name for name, _ in records], ["e2e.json"])
        self.assertIn("Unavailable measured source in latest dev run: nextest", result.stdout)

    def test_independent_artifacts_take_precedence_over_combined_fallbacks(self):
        self.env.update(ARTIFACTS=json.dumps(["e2e-evidence", "nextest-evidence", "d7-evidence"]),
                        INVALID_ARTIFACTS=json.dumps(["d7-evidence"]))
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len((self.root / "ingested").read_text().splitlines()), 2)

    def test_untrusted_stale_or_incomplete_set_never_writes(self):
        original_run, original_data = self.run.copy(), self.data.copy()
        cases = (('branch', 'dev push'), ('event', 'dev push'), ('commit', 'commit differs'),
                 ('stale', 'stale'), ('invalid', 'invalid row'), ('missing', 'no measured artifacts'), ('empty', 'completed dev'))
        for case, message in cases:
            with self.subTest(case=case):
                self.run, self.data = original_run.copy(), original_data.copy()
                self.env['ARTIFACTS'] = json.dumps(["d7-evidence"])
                self.env.pop('INVALID_SOURCE', None)
                if case == 'branch': self.run['headBranch'] = 'feature'
                if case == 'event': self.run['event'] = 'pull_request'
                if case == 'commit': self.data['commit'] = 'b' * 40
                if case == 'stale': self.data['run_at'] = (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()
                if case == 'invalid': self.env['INVALID_SOURCE'] = 'nextest'
                if case == 'missing': self.env['ARTIFACTS'] = '[]'
                if case == 'empty': self.run = None
                result = self.invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((self.root / "ingested").exists())


if __name__ == '__main__': unittest.main()

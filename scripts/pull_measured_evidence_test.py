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
        self.jobs = {"states-timings": "success", "release-evidence": "success"}
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
    assert '--paginate' in args and '--slurp' in args
    if args[1] == 'repos/sample/console/actions/runs/123/jobs':
        print(json.dumps([{{'jobs': [{{'name': name, 'conclusion': conclusion}}]}}
                          for name, conclusion in json.loads(os.environ['JOBS']).items()]))
    else:
        assert args[1] == 'repos/sample/console/actions/runs/123/artifacts'
        print(json.dumps([{{'artifacts': [{{'name': name}} for name in json.loads(os.environ['ARTIFACTS'])]}}]))
elif args[:2] == ['run', 'download']:
    assert args[2] == '123'
    artifact = args[args.index('--name') + 1]
    assert artifact in json.loads(os.environ['ARTIFACTS'])
    Path(args[args.index('--dir') + 1]).mkdir()
    names = ('e2e', 'nextest') if artifact == 'd7-evidence' else (artifact.removesuffix('-evidence'),)
    if artifact == 'd8-evidence': names = ('states',)
    for name in names:
        data = json.loads(os.environ['DATA'])
        if name == os.environ.get('INVALID_SOURCE'): data['invalid'] = True
        if artifact in json.loads(os.environ.get('INVALID_ARTIFACTS', '[]')): data['invalid'] = True
        (Path(args[args.index('--dir') + 1]) / (name + '.json')).write_text(json.dumps(data))
else: sys.exit('unexpected gh invocation: ' + repr(args))
''')
        (self.root / "gh").chmod(0o755)
        self.env = {**os.environ, "PATH": str(self.root) + os.pathsep + os.environ["PATH"],
                    "INGEST_LOG": str(self.root / "ingested"), "ARTIFACTS": json.dumps(["states-evidence", "d7-evidence"])}

    def invoke(self):
        self.env.update(RUN=json.dumps([self.run] if self.run else []), DATA=json.dumps(self.data), JOBS=json.dumps(self.jobs))
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

    def test_available_sources_ingest_independently_without_older_run_fallback(self):
        for sources in (("states",), ("e2e",), ("nextest",), ("states", "e2e"), ("e2e", "nextest"), ("states", "e2e", "nextest")):
            with self.subTest(sources=sources):
                self.env['ARTIFACTS'] = json.dumps([name + "-evidence" for name in sources])
                result = self.invoke()
                self.assertEqual(result.returncode, 0, result.stderr)
                records = [json.loads(line) for line in (self.root / "ingested").read_text().splitlines()]
                self.assertEqual([name for name, _ in records], [name + ".json" for name in sources])
                self.assertTrue(all(data == self.data for _, data in records))
                (self.root / "ingested").unlink()

    def test_available_invalid_source_never_partially_ingests(self):
        self.env.update(ARTIFACTS=json.dumps(["states-evidence", "e2e-evidence"]), INVALID_SOURCE="e2e")
        result = self.invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid row", result.stderr)
        self.assertFalse((self.root / "ingested").exists())

    def test_unsuccessful_or_missing_producer_never_ingests(self):
        for job, artifact in (("release-evidence", "states-evidence"), ("states-timings", "e2e-evidence")):
            for conclusion in ("failure", "cancelled", "timed_out", "action_required", "neutral", None, "missing"):
                with self.subTest(job=job, conclusion=conclusion):
                    self.jobs = {"states-timings": "success", "release-evidence": "success"}
                    if conclusion == "missing": del self.jobs[job]
                    else: self.jobs[job] = conclusion
                    self.env['ARTIFACTS'] = json.dumps([artifact])
                    result = self.invoke()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(f"producer {job}", result.stderr)
                    self.assertFalse((self.root / "ingested").exists())

    def test_failed_producer_with_published_artifacts_never_ingests(self):
        for artifact, job in (("states-evidence", "states-timings"), ("d8-evidence", "release-evidence"),
                              ("e2e-evidence", "release-evidence"), ("nextest-evidence", "release-evidence"),
                              ("d7-evidence", "release-evidence")):
            with self.subTest(artifact=artifact):
                self.jobs = {"states-timings": "success", "release-evidence": "success", job: "failure"}
                self.env['ARTIFACTS'] = json.dumps([artifact])
                result = self.invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"producer {job}", result.stderr)
                self.assertFalse((self.root / "ingested").exists())

    def test_skipped_release_allows_states_only(self):
        self.jobs['release-evidence'] = "skipped"
        self.env['ARTIFACTS'] = json.dumps(["states-evidence"])
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        records = [json.loads(line) for line in (self.root / "ingested").read_text().splitlines()]
        self.assertEqual([name for name, _ in records], ["states.json"])
        self.assertIn("Unavailable measured source in latest dev run: e2e", result.stdout)
        self.assertIn("Unavailable measured source in latest dev run: nextest", result.stdout)

    def test_successful_web_only_run_allows_missing_nextest(self):
        self.env['ARTIFACTS'] = json.dumps(["states-evidence", "e2e-evidence"])
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        records = [json.loads(line) for line in (self.root / "ingested").read_text().splitlines()]
        self.assertEqual([name for name, _ in records], ["states.json", "e2e.json"])
        self.assertIn("Unavailable measured source in latest dev run: nextest", result.stdout)

    def test_states_fallback_checks_release_job_instead_of_states_job(self):
        self.jobs['states-timings'] = "failure"
        self.env['ARTIFACTS'] = json.dumps(["d8-evidence", "d7-evidence"])
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len((self.root / "ingested").read_text().splitlines()), 3)

    def test_independent_artifacts_take_precedence_over_combined_fallbacks(self):
        self.env.update(ARTIFACTS=json.dumps(["states-evidence", "e2e-evidence", "nextest-evidence", "d8-evidence", "d7-evidence"]),
                        INVALID_ARTIFACTS=json.dumps(["d8-evidence", "d7-evidence"]))
        result = self.invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len((self.root / "ingested").read_text().splitlines()), 3)

    def test_untrusted_stale_or_incomplete_set_never_writes(self):
        original_run, original_data = self.run.copy(), self.data.copy()
        cases = (('branch', 'dev push'), ('event', 'dev push'), ('commit', 'commit differs'),
                 ('stale', 'stale'), ('invalid', 'invalid row'), ('missing', 'no measured artifacts'), ('empty', 'completed dev'))
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
                if case == 'missing': self.env['ARTIFACTS'] = '[]'
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

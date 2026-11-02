# SPDX-License-Identifier: LicenseRef-Proprietary
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("d7-evidence.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.time = self.now.isoformat()
        self.report = {"stats": {"startTime": self.time}, "errors": [], "suites": [
            {"title": "first-run-solo.spec.ts", "file": "first-run-solo.spec.ts", "specs": [
                {"title": "solo", "file": "first-run-solo.spec.ts", "tests": [{"projectName": "parallel", "expectedStatus": "passed", "results": [
                    {"status": "passed", "steps": [{"title": "J2 entity", "duration": 10}]}]}]}]}]}
        self.index = [{"operation": "POST /api/v1/sample", "code": "sample_refused",
                       "ui": [{"file": "e2e/first-run-solo.spec.ts", "title": "solo"}],
                       "be": [{"file": "backend/sample/tests/refusals.rs", "binary": "sample::refusals", "title": "refuses"}]}]

    def rows(self, report=None):
        return producer.e2e_rows(report or self.report, self.index)

    def test_both_browsers_and_nested_failure_are_preserved(self):
        self.assertEqual(self.rows()[0]["status"], "pass")
        r = copy.deepcopy(self.report)
        run = r["suites"][0]["specs"][0]["tests"][0]
        run["projectName"] = "firefox"
        run["results"][0]["steps"][0]["steps"] = [{"title": "register", "error": {"message": "refused"}}]
        rows = self.rows(r)
        self.assertEqual(rows[0]["status"], "fail")
        self.assertEqual(rows[0]["browser"], "firefox")
        self.assertIn("register", rows[0]["title"])

    def test_skips_missing_results_and_failed_retries_never_pass(self):
        run = self.report["suites"][0]["specs"][0]["tests"][0]
        for status in ("skipped", "interrupted", "timedOut", "failed"):
            run["results"][0]["status"] = status
            self.assertNotEqual(self.rows()[-1]["status"], "pass")
        run["results"].append({"status": "passed", "steps": [{"title": "J2 entity", "duration": 10}]})
        self.assertIn("fail", [r["status"] for r in self.rows()])
        run["results"] = []
        self.assertEqual(self.rows()[-1]["status"], "unknown")

    def test_missing_code_assertions_do_not_get_a_row(self):
        self.index[0]["ui"] = []
        self.assertEqual(len(self.rows()), 1)

    def test_other_specs_and_expected_failures_cannot_supply_solo_journey_green(self):
        spec = self.report["suites"][0]["specs"][0]
        spec["tests"][0]["expectedStatus"] = "failed"
        self.assertTrue(all(row["status"] == "unknown" for row in self.rows()))
        spec["file"] = "mock/sample.spec.ts"
        self.assertEqual(self.rows(), [])

    def test_default_mock_project_is_chromium_only_for_the_known_config(self):
        self.report["suites"][0]["specs"][0]["tests"][0]["projectName"] = ""
        self.assertEqual(self.rows()[-1]["browser"], "unknown")
        self.report["config"] = {"configFile": "/repo/e2e/mock/playwright.config.ts"}
        self.assertEqual(self.rows()[-1]["browser"], "chromium")

    def test_junit_join_requires_binary_and_unique_title_and_executed_success(self):
        def xml(body, binary="sample::refusals"):
            return f'<testsuites timestamp="{self.time}"><testsuite><testcase classname="{binary}" name="refuses">{body}</testcase></testsuite></testsuites>'
        self.assertEqual(producer.nextest_rows(xml(""), self.index)[0]["status"], "pass")
        for tag in ("failure", "error", "rerunFailure", "flakyFailure", "skipped"):
            self.assertNotEqual(producer.nextest_rows(xml(f"<{tag}/>"), self.index)[0]["status"], "pass")
        self.assertEqual(producer.nextest_rows(xml("", "different::refusals"), self.index), [])
        self.assertEqual(producer.nextest_rows(xml("").replace('name="refuses"', 'name="other::refuses"'), self.index), [])
        self.index[0]["be"].append({**self.index[0]["be"][0], "file": "other.rs"})
        self.assertTrue(all(row["status"] == "unknown" for row in producer.nextest_rows(xml(""), self.index)))
        with self.assertRaises(ValueError):
            producer.nextest_rows("<broken>", self.index)

    def test_stale_future_and_invalid_times_are_refused(self):
        for value in ((self.now - timedelta(days=9)).isoformat(), (self.now + timedelta(days=1)).isoformat(), "yesterday", "2026-01-01T09:00:00+09:00"):
            with self.assertRaises(ValueError):
                producer.fresh(value)
        self.assertEqual(producer.fresh(self.time), self.time)

    def test_age_limit_and_diagnostic_read_one_constant(self):
        from unittest.mock import patch
        with patch.object(producer, "MAX_AGE_DAYS", 1):
            with self.assertRaisesRegex(ValueError, "1 days"):
                producer.fresh((self.now - timedelta(days=2)).isoformat())

    def test_cli_uses_report_time_commit_and_rejects_stale_inputs_before_writing(self):
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "node").write_text(f'#!{sys.executable}\nprint({json.dumps(json.dumps(self.index))})\n')
            (root / "node").chmod(0o755)
            report = root / "report.json"
            report.write_text(json.dumps(self.report))
            xml = root / "junit.xml"
            xml.write_text(f'<testsuites timestamp="{self.time}"><testsuite><testcase classname="sample::refusals" name="refuses"/></testsuite></testsuites>')
            command = [sys.executable, str(Path(producer.__file__).resolve()), str(root / "out"), str(xml), str(report)]
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads((root / "out/e2e.json").read_text())
            self.assertEqual(data["run_at"], self.time)
            self.assertEqual(len(data["commit"]), 40)
            self.assertIn("d7-evidence.py", data["source_command"])
            before = (root / "out/e2e.json").read_text()
            self.report["stats"]["startTime"] = (self.now - timedelta(days=9)).isoformat()
            report.write_text(json.dumps(self.report))
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)
            self.assertEqual((root / "out/e2e.json").read_text(), before)

    def test_cli_merges_all_shard_reports_and_retains_failures(self):
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "node").write_text(f'#!{sys.executable}\nprint({json.dumps(json.dumps(self.index))})\n')
            (root / "node").chmod(0o755)
            (root / "report.json").write_text(json.dumps(self.report))
            for shard in (1, 2):
                target = root / "shards" / str(shard)
                target.mkdir(parents=True)
                failure = "<failure/>" if shard == 2 else ""
                (target / "junit.xml").write_text(f'<testsuites timestamp="{self.time}"><testsuite><testcase classname="sample::refusals" name="refuses">{failure}</testcase></testsuite></testsuites>')
            command = [sys.executable, str(Path(producer.__file__).resolve()), str(root / "out"), str(root / "shards"), str(root / "report.json")]
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads((root / "out/nextest.json").read_text())
            self.assertEqual([row["status"] for row in data["rows"]], ["pass", "fail"])
            self.assertEqual(data["run_at"], self.time)
            (root / "shards/2/junit.xml").write_text('<testsuites><testsuite/></testsuites>')
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("timestamp required for every shard", result.stderr)
            for file in (root / "shards").rglob("junit.xml"): file.unlink()
            result = subprocess.run(command, env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("nextest JUnit required", result.stderr)

    def test_pull_without_public_remote_resolves_repo_and_refuses_invalid_artifacts(self):
        import subprocess
        import sys
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "git").write_text(f'''#!{sys.executable}
import os, sys
if sys.argv[1:4] == ['remote', 'get-url', 'public']:
    sys.exit("error: No such remote 'public'")
os.execv({shutil.which('git')!r}, ['git', *sys.argv[1:]])
''')
            (root / "git").chmod(0o755)
            (root / "evidence.py").write_text('''import os, sys
from pathlib import Path
def validate(data, name): pass
if __name__ == '__main__':
    with Path(os.environ['D7_INGEST_LOG']).open('a') as log:
        log.write(sys.argv[1] + ' ' + Path(sys.argv[2]).name + '\\n')
''')
            fake = root / "gh"
            fake.write_text(f'''#!{sys.executable}
import json,os,sys
from pathlib import Path
if sys.argv[1:3] == ['repo', 'view']:
    assert os.environ['D7_REPO_LOOKUP'] == '1', sys.argv
    print(os.environ['D7_REPO'])
elif sys.argv[1:3] == ['run', 'view']:
    assert sys.argv[sys.argv.index('--repo') + 1] == os.environ['D7_REPO'], sys.argv
    print(os.environ['D7_RUN'])
elif sys.argv[1:3] == ['run', 'download']:
    assert sys.argv[sys.argv.index('--repo') + 1] == os.environ['D7_REPO'], sys.argv
    root = Path(sys.argv[sys.argv.index('--dir') + 1])
    for name in ('e2e', 'nextest'):
        (root / (name + '.json')).write_text(os.environ['D7_ARTIFACT'])
else: sys.exit('unexpected gh command: ' + repr(sys.argv))
''')
            fake.chmod(0o755)
            run = {"headSha": "a" * 40, "headBranch": "dev", "event": "push"}
            data = {"commit": run["headSha"], "run_at": self.time}
            cases = [({**run, "headBranch": "feature"}, data, "dev push"),
                     ({**run, "event": "pull_request"}, data, "dev push"),
                     (run, {**data, "commit": "b" * 40}, "commit differs"),
                     (run, {**data, "run_at": (self.now - timedelta(days=9)).isoformat()}, "stale")]
            for metadata, artifact, message in cases:
                env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"],
                       "D7_RUN": json.dumps(metadata), "D7_ARTIFACT": json.dumps(artifact),
                       "GITHUB_REPOSITORY": "environment-owner/environment-repo",
                       "D7_REPO": "environment-owner/environment-repo", "D7_REPO_LOOKUP": "0",
                       "D7_INGEST_LOG": str(root / "ingest.log")}
                result = subprocess.run(["bash", "scripts/pull-d7-evidence.sh", "123", directory], env=env, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse((root / "ingest.log").exists())
            env.update(D7_RUN=json.dumps(run), D7_ARTIFACT=json.dumps(data))
            sources = [("argument", ["argument-owner/argument-repo"], "environment-owner/environment-repo", "argument-owner/argument-repo"),
                       ("environment", [], "environment-owner/environment-repo", "environment-owner/environment-repo"),
                       ("gh discovery", [], None, "discovered-owner/discovered-repo"),
                       ("empty environment", [], "", "discovered-owner/discovered-repo")]
            for source, args, repository, expected in sources:
                with self.subTest(source=source):
                    env.pop("GITHUB_REPOSITORY", None)
                    if repository is not None:
                        env["GITHUB_REPOSITORY"] = repository
                    env.update(D7_REPO=expected, D7_REPO_LOOKUP="1" if not args and not repository else "0")
                    result = subprocess.run(["bash", "scripts/pull-d7-evidence.sh", "123", directory, *args], env=env, capture_output=True, text=True)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual((root / "ingest.log").read_text().splitlines(), ["ingest e2e.json", "ingest nextest.json"])
                    (root / "ingest.log").unlink()

    @unittest.skipUnless(os.environ.get("EVIDENCE_READER_DIR"), "reader proof requires EVIDENCE_READER_DIR")
    def test_produced_failure_turns_real_module_red_and_stale_file_stays_pending(self):
        import sys
        sys.path.insert(0, str(Path(os.environ["EVIDENCE_READER_DIR"])))
        import evidence
        import build
        from unittest.mock import patch
        module = {"id": "entity", "routes": [], "journeys": ["J2"]}
        r = self.report["suites"][0]["specs"][0]["tests"][0]["results"][0]
        r["steps"][0]["error"] = {"message": "planted"}
        import subprocess
        commit = subprocess.check_output(["git", "rev-parse", "public/dev"], text=True).strip()
        with tempfile.TemporaryDirectory() as directory, patch.object(evidence, "ROOT", Path(directory)), patch.object(evidence, "REPO", str(Path.cwd())):
            file = Path(directory) / "input" / "e2e.json"
            file.parent.mkdir()
            data = {"commit": commit, "run_at": self.time, "source_command": "synthetic negative control", "rows": self.rows()}
            file.write_text(json.dumps(data))
            evidence.ingest(file)
            criteria, note = evidence.dim(module, "D7")
            self.assertEqual(criteria[1], (False, 0))
            self.assertEqual(build.mature({"D7": (criteria, note)}, {"D7": {"level": 5, "evidence": "cannot override red"}})["dims"]["D7"]["level"], 1)
            self.assertIn("J2", note)
            data["run_at"] = (self.now - timedelta(days=9)).isoformat()
            file.write_text(json.dumps(data))
            evidence.ingest(file)
            criteria, note = evidence.dim(module, "D7")
            self.assertEqual(criteria[1], (True, 1))
            self.assertIn("9 d old", note)
            evidence.load.cache_clear()


if __name__ == "__main__":
    unittest.main()

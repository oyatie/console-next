# SPDX-License-Identifier: LicenseRef-Proprietary
import base64
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("d10-evidence.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class D10Test(unittest.TestCase):
    def setUp(self):
        self.operation = "POST /api/v1/sample"
        self.probe = {"operation": self.operation, "principal": "no-grant", "http_status": 403, "control_http_status": 422}
        self.report = {"errors": [], "suites": [{"specs": [{"file": "authz/write-refusals.spec.ts", "title": "refuses", "tests": [
            {"projectName": "parallel", "expectedStatus": "passed", "results": [{"status": "passed", "attachments": []}]}]}]}]}

    def rows(self):
        run = self.report["suites"][0]["specs"][0]["tests"][0]["results"][0]
        run["attachments"] = [{"name": "write-probe", "contentType": "application/json",
                               "body": base64.b64encode(json.dumps(self.probe).encode()).decode()}]
        return producer.probe_rows(self.report)

    def test_only_an_executed_no_grant_probe_with_a_control_can_pass(self):
        self.assertEqual(self.rows()[0]["status"], "pass")
        for field, value in (("principal", "ops"), ("control_http_status", 403), ("control_http_status", 401),
                             ("http_status", 401), ("http_status", 422), ("http_status", True)):
            with self.subTest(field=field, value=value):
                original = copy.deepcopy(self.probe)
                self.probe[field] = value
                self.assertNotEqual(self.rows()[0]["status"], "pass")
                self.probe = original
        self.probe["http_status"] = 201
        self.assertEqual(self.rows()[0]["status"], "fail")

    def test_failed_retries_expected_failures_and_report_errors_never_pass(self):
        test = self.report["suites"][0]["specs"][0]["tests"][0]
        test["results"][0]["status"] = "failed"
        self.assertNotEqual(self.rows()[0]["status"], "pass")
        test["results"][0]["status"] = "passed"
        test["expectedStatus"] = "failed"
        self.assertNotEqual(self.rows()[0]["status"], "pass")
        test["expectedStatus"] = "passed"
        self.report["errors"] = [{"message": "harness failed"}]
        self.assertNotEqual(self.rows()[0]["status"], "pass")

    def test_missing_probe_or_any_failed_attempt_cannot_supply_coverage(self):
        census = [{"operation": self.operation, "models": ["Cedar"], "cedar_actions": ["sample_write"]}]
        self.assertEqual(producer.authorization_rows(census, [])[0]["status"], "unknown")
        rows = self.rows()
        self.assertEqual(producer.authorization_rows(census, rows)[0]["negative_test"], True)
        self.assertEqual(producer.authorization_rows(census, rows + [{**rows[0], "status": "unknown"}])[0]["negative_test"], False)
        self.assertEqual(producer.authorization_rows(census, rows + [{**rows[0], "status": "fail"}])[0]["status"], "fail")

    def test_code_coverage_without_no_grant_probe_is_not_authorization_proof(self):
        row = producer.authorization_rows([{"operation": self.operation, "models": [], "cedar_actions": []}], [])[0]
        self.assertFalse(row["negative_test"])
        self.assertEqual(row["status"], "unknown")
        self.assertEqual(row["tests"], [])

    def test_shared_age_constant_controls_limit_and_error_message(self):
        from datetime import datetime, timedelta, timezone
        with patch.object(producer.d7, "MAX_AGE_DAYS", 1):
            with self.assertRaisesRegex(ValueError, "1 days"):
                producer.d7.fresh((datetime.now(timezone.utc) - timedelta(days=2)).isoformat())

    def test_missing_or_failed_retry_with_no_attachment_never_passes(self):
        test = self.report["suites"][0]["specs"][0]["tests"][0]
        self.rows()
        test["results"].insert(0, {"status": "failed"})
        self.assertEqual(producer.probe_rows(self.report)[0]["status"], "fail")
        test["results"][0]["status"] = "skipped"
        self.assertEqual(producer.probe_rows(self.report)[0]["status"], "unknown")

    def test_cli_preserves_all_writes_and_report_dates_and_rejects_stale_or_other_commits(self):
        from datetime import datetime, timedelta, timezone
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            time = datetime.now(timezone.utc).isoformat()
            self.report["stats"] = {"startTime": time}
            self.rows()
            report = root / "playwright.json"
            report.write_text(json.dumps(self.report))
            census = [{"operation": op, "models": ["Cedar"], "cedar_actions": ["sample_write"]} for op in (self.operation, "DELETE /unprobed")]
            (root / "census.json").write_text(json.dumps(census))
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
            envelope = {"commit": commit, "run_at": time, "source_command": "synthetic fixture", "rows": []}
            for source in ("e2e", "nextest"):
                (root / (source + ".json")).write_text(json.dumps(envelope))
            command = [sys.executable, str(Path(producer.__file__).resolve()), str(root / "out"), str(root / "census.json"), directory, str(report)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            output = root / "out/authorization.json"
            before = output.read_text()
            data = json.loads(before)
            self.assertEqual(data["run_at"], time)
            self.assertEqual(data["commit"], commit)
            self.assertNotIn(directory, data["source_command"])
            self.assertEqual([r["status"] for r in data["rows"]], ["pass", "unknown"])
            self.report["stats"]["startTime"] = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
            report.write_text(json.dumps(self.report))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)
            self.assertEqual(output.read_text(), before)
            report.write_text(json.dumps({**self.report, "stats": {"startTime": time}}))
            (root / "nextest.json").write_text(json.dumps({**envelope, "commit": "0" * 40}))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("commit differs", result.stderr)
            self.assertEqual(output.read_text(), before)

    def test_pull_uses_explicit_or_environment_repository_and_validates_before_ingest(self):
        from datetime import datetime, timezone
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "gh").write_text(f'''#!{sys.executable}
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
assert args[args.index('--repo') + 1] == os.environ['EXPECTED_REPO']
if args[:2] == ['run', 'view']:
    print(os.environ['RUN_JSON'])
else:
    assert args[args.index('--name') + 1] == 'd10-evidence'
    Path(args[args.index('--dir') + 1], 'authorization.json').write_text(os.environ['ARTIFACT_JSON'])
''')
            (root / "gh").chmod(0o755)
            (root / "evidence.py").write_text('''import os
from pathlib import Path
def validate(data, name):
    assert name == 'authorization'
if __name__ == '__main__': Path(os.environ['INGEST_LOG']).write_text('ingested')
''')
            data = {"commit": "a" * 40, "run_at": datetime.now(timezone.utc).isoformat()}
            run = {"headSha": data["commit"], "headBranch": "dev", "event": "push"}
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"], "GITHUB_REPOSITORY": "env/repo",
                   "INGEST_LOG": str(root / "ingest"), "ARTIFACT_JSON": json.dumps(data)}
            for repository, args in (("env/repo", []), ("argument/repo", ["argument/repo"])):
                env.update(EXPECTED_REPO=repository, RUN_JSON=json.dumps(run))
                command = ["bash", "scripts/pull-d10-evidence.sh", "123", directory, *args]
                result = subprocess.run(command, env=env, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertTrue((root / "ingest").exists())
                (root / "ingest").unlink()
                for bad in ({**run, "event": "pull_request"}, {**run, "headBranch": "feature"}, {**run, "headSha": "b" * 40}):
                    env['RUN_JSON'] = json.dumps(bad)
                    result = subprocess.run(command, env=env, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertFalse((root / "ingest").exists())

    @unittest.skipUnless(os.environ.get("EVIDENCE_READER_DIR"), "reader proof requires EVIDENCE_READER_DIR")
    def test_produced_rows_drive_l1_l2_l3_and_stale_pending_in_the_reader(self):
        from datetime import datetime, timedelta, timezone
        sys.path.insert(0, os.environ["EVIDENCE_READER_DIR"])
        import evidence
        import build
        module = {"id": "sample", "routes": [], "journeys": []}
        operation = {"method": "POST", "path": "/api/v1/sample", "exposure": "exposed", "refusal_codes": []}
        census = [{"operation": self.operation, "models": ["Cedar"], "cedar_actions": ["sample_write"]}]
        commit = subprocess.check_output(["git", "rev-parse", "public/dev"], text=True).strip()
        with tempfile.TemporaryDirectory() as directory, patch.object(evidence, "ROOT", Path(directory)), patch.object(evidence, "REPO", str(Path.cwd())):
            artifact = Path(directory, "input/authorization.json")
            artifact.parent.mkdir()
            def score(rows, age=0):
                artifact.write_text(json.dumps({"commit": commit, "run_at": (datetime.now(timezone.utc) - timedelta(days=age)).isoformat(),
                    "source_command": "synthetic producer-reader controls", "rows": rows}))
                evidence.ingest(artifact)
                result = evidence.dim(module, "D10", [operation])
                return build.mature({"D10": result}, {})["dims"]["D10"]
            rows = producer.authorization_rows(census, self.rows())
            self.assertEqual(score(rows)["level"], 3)
            self.assertEqual(score([{**rows[0], "cedar_actions": []}])["level"], 2)
            red = score(producer.authorization_rows(census, []))
            self.assertEqual(red["level"], 1)
            self.assertIn(self.operation, red["evidence"])
            self.assertIn(commit, red["evidence"])
            stale = score(rows, age=9)
            self.assertEqual(stale["level"], 1)
            self.assertIn("9 d old", stale["evidence"])
            evidence.load.cache_clear()


if __name__ == "__main__":
    unittest.main()

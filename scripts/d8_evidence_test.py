# SPDX-License-Identifier: LicenseRef-Proprietary
"""Synthetic report controls for support-reference evidence."""
import base64
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("d8-evidence.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class SupportEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.time = datetime.now(timezone.utc).isoformat()
        self.row = {"route": "/sample", "state": "failed", "support_ref": "a" * 32, "reference_count": 1,
                    "status": "pass", "injected": 1, "settled": True, "rendered_ref": "a" * 32, "display": "a" * 8, "copy_count": 1,
                    "raw_server_text": False, "floorplan": None, "declared_floorplan": None}
        self.report = {"stats": {"startTime": self.time}, "errors": [], "suites": [{"specs": [{
            "file": "states/support-ref-failed-a.spec.ts", "title": "reference", "tests": [{"expectedStatus": "passed",
            "projectName": "", "results": [{"status": "passed", "attachments": []}]}]}]}]}

    def rows(self, name="support-reference", row=None):
        self.report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"] = [{
            "name": name, "contentType": "application/json", "body": base64.b64encode(json.dumps(row or self.row).encode()).decode()}]
        return producer.state_rows(self.report)

    def test_state_rows_require_executed_success_and_the_owned_spec(self):
        self.assertEqual(self.rows()[0]["status"], "pass")
        for file in (
                "support-ref-failed-a.spec.ts", "support-ref-failed-b.spec.ts",
                "support-ref-refused-a.spec.ts", "support-ref-refused-b.spec.ts",
                "support-ref-no-reference-a.spec.ts", "support-ref-no-reference-b.spec.ts"):
            self.report["suites"][0]["specs"][0]["file"] = "states/" + file
            self.assertEqual(self.rows()[0]["status"], "pass")
        run = self.report["suites"][0]["specs"][0]["tests"][0]
        for state in ("failed", "timedOut", "skipped", "interrupted"):
            run["results"][0]["status"] = state
            self.assertNotEqual(self.rows()[0]["status"], "pass")
        run["results"][0]["status"] = "passed"
        run["results"].insert(0, {"status": "failed"})
        self.assertNotEqual(self.rows()[0]["status"], "pass")
        run["results"].pop(0)
        run["expectedStatus"] = "failed"
        self.assertNotEqual(self.rows()[0]["status"], "pass")
        run["expectedStatus"] = "passed"
        self.report["errors"] = [{"message": "harness fault"}]
        self.assertNotEqual(self.rows()[0]["status"], "pass")
        self.report["suites"][0]["specs"][0]["file"] = "unrelated.spec.ts"
        self.assertEqual(self.rows(), [])

    def test_missing_attachment_is_unknown_and_forged_status_is_refused(self):
        self.assertEqual(self.rows(row={**self.row, "status": "pass"})[0]["status"], "pass")
        self.report["suites"][0]["specs"][0]["tests"][0]["results"][0]["status"] = "failed"
        self.assertEqual(self.rows()[0]["status"], "fail")
        self.assertEqual(self.rows(name="other"), [])
        self.report["suites"][0]["specs"][0]["tests"][0]["results"][0]["status"] = "passed"
        self.assertEqual(self.rows(row={**self.row, "status": "fail"})[0]["status"], "fail")
        with self.assertRaisesRegex(ValueError, "invalid state observation status"):
            self.rows(row={**self.row, "status": "forged"})

    def test_wrong_file_suffix_and_non_inline_attachments_are_refused(self):
        self.report["suites"][0]["specs"][0]["file"] = "notstates/support-ref-failed-a.spec.ts"
        self.assertEqual(self.rows(), [])
        self.report["suites"][0]["specs"][0]["file"] = "states/support-ref-failed-a.spec.ts"
        self.rows()
        attachment = self.report["suites"][0]["specs"][0]["tests"][0]["results"][0]["attachments"][0]
        del attachment["body"]
        attachment["path"] = "artifact.json"
        with self.assertRaisesRegex(ValueError, "inline"):
            producer.state_rows(self.report)

    def test_live_resolution_keeps_the_refusal_and_requires_matching_ops_lookup(self):
        probe = {"operation": "POST /api/v1/sample", "status": "pass", "http_status": 403,
                 "support_ref": "a" * 32, "ops_http_status": 200, "ops_support_ref": "a" * 32}
        self.assertTrue(producer.resolved(probe))
        for field, value in (("status", "unknown"), ("http_status", 422), ("support_ref", None),
                             ("ops_http_status", 403), ("ops_support_ref", "b" * 32)):
            self.assertFalse(producer.resolved({**probe, field: value}))

    def test_cli_preserves_e2e_rows_and_report_dates_and_refuses_stale_reports(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.rows()
            report = root / "report.json"
            report.write_text(json.dumps(self.report))
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
            envelope = {"commit": commit, "run_at": self.time, "source_command": "synthetic report",
                        "rows": [{"kind": "client-errors", "title": "beacon", "browser": "chromium", "status": "pass"}]}
            (root / "e2e.json").write_text(json.dumps(envelope))
            command = [sys.executable, producer.__file__, str(root / "out"), str(root / "e2e.json"), str(report)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            data = json.loads((root / "out/states.json").read_text())
            self.assertEqual(data["commit"], commit)
            self.assertEqual(data["run_at"], self.time)
            self.assertNotIn(directory, data["source_command"])
            self.assertEqual(data["rows"][0]["status"], "pass")
            self.assertEqual(json.loads((root / "out/e2e.json").read_text())["rows"], envelope["rows"])
            self.report["stats"]["startTime"] = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
            report.write_text(json.dumps(self.report))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)
            report.write_text(json.dumps({**self.report, "stats": {"startTime": self.time}}))
            (root / "e2e.json").write_text(json.dumps({**envelope, "run_at": (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()}))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)
            (root / "e2e.json").write_text(json.dumps({**envelope, "commit": "0" * 40}))
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)

    @unittest.skipUnless(os.environ.get("EVIDENCE_READER_DIR"), "reader proof requires EVIDENCE_READER_DIR")
    def test_report_observations_raise_only_with_live_resolution_and_turn_red_without_a_reference(self):
        sys.path.insert(0, os.environ["EVIDENCE_READER_DIR"])
        import evidence
        import build
        module = {"id": "sample", "routes": ["/sample"], "journeys": []}
        operation = {"method": "POST", "path": "/api/v1/sample", "exposure": "exposed"}
        rows = self.rows() + self.rows(row={**self.row, "state": "refused"}) + self.rows(row={
            **self.row, "state": "no-reference", "support_ref": None, "reference_count": 0,
            "rendered_ref": None, "display": None, "copy_count": 0})
        commit = subprocess.check_output(["git", "rev-parse", "public/dev"], text=True).strip()
        with tempfile.TemporaryDirectory() as directory, patch.object(evidence, "ROOT", Path(directory)), patch.object(evidence, "REPO", str(Path.cwd())):
            source = Path(directory, "input")
            source.mkdir()
            def put(name, data):
                file = source / (name + ".json")
                file.write_text(json.dumps({"commit": commit, "run_at": self.time, "source_command": "synthetic report controls", "rows": data}))
                evidence.ingest(file)
            def score():
                return build.mature({"D8": evidence.dim(module, "D8", [operation])}, {})["dims"]["D8"]
            put("states", rows)
            put("e2e", [{"kind": "client-errors", "title": "beacon", "browser": "chromium", "status": "pass"}])
            probe = {"operation": "POST /api/v1/sample", "status": "pass", "http_status": 403, "support_ref": "a" * 32,
                     "ops_http_status": 200, "ops_support_ref": "a" * 32}
            put("write-probe", [{**probe, "ops_resolved": producer.resolved(probe)}])
            self.assertEqual(score()["level"], 2)
            rows[0]["rendered_ref"] = None
            put("states", rows)
            red = score()
            self.assertEqual(red["level"], 1)
            self.assertIn("/sample", red["evidence"])
            self.assertIn(commit, red["evidence"])
            self.assertIn(self.time, red["evidence"])
            evidence.load.cache_clear()


if __name__ == "__main__":
    unittest.main()

# SPDX-License-Identifier: LicenseRef-Proprietary
"""Controls for route-state evidence; missing or unexecuted observations never pass."""
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("states-evidence.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class StatesEvidenceTest(unittest.TestCase):
    def setUp(self):
        self.inventory = {"floorplans": {"/": "P-01", "/uncovered": None}}
        self.observation = {"route": "/", "state": "empty", "status": "pass", "support_ref": None,
                            "reference_count": 0, "raw_server_text": False, "floorplan": "P-01"}
        self.test = {"expectedStatus": "passed", "results": [{"status": "passed", "attachments": []}]}
        self.report = {"config": {"metadata": {"commit": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()}}, "stats": {"startTime": datetime.now(timezone.utc).isoformat()}, "errors": [],
                       "suites": [{"specs": [{"file": "states/screens.spec.ts", "tests": [self.test]}]}]}
        self.attach()

    def attach(self):
        self.test["results"][-1]["attachments"] = [{"name": "screen-state", "contentType": "application/json",
            "body": base64.b64encode(json.dumps(self.observation).encode()).decode()}]

    def rows(self):
        return producer.rows(self.inventory, [self.report])

    def observed(self):
        return next(r for r in self.rows() if r["route"] == "/" and r["state"] == "empty")

    def test_each_route_has_four_states_and_missing_is_unknown(self):
        rows = self.rows()
        self.assertEqual(len(rows), 8)
        self.assertEqual(self.observed()["status"], "pass")
        self.assertEqual(self.observed()["kind"], "screen-state")
        self.assertEqual(self.observed()["declared_floorplan"], "P-01")
        self.assertEqual(sum(r["status"] == "unknown" for r in rows), 7)
        self.assertEqual({r["state"] for r in rows}, {"loading", "failed", "empty", "refused"})

    def test_failed_retry_stays_red_and_skipped_is_unknown(self):
        for status, expected in (("failed", "fail"), ("timedOut", "fail"), ("skipped", "unknown"), ("interrupted", "unknown")):
            self.test["results"][0]["status"] = status
            self.assertEqual(self.observed()["status"], expected)
        self.test["results"] = [{"status": "failed"}, {"status": "passed"}]
        self.attach()
        self.assertEqual(self.observed()["status"], "fail")

    def test_expected_failure_report_error_and_missing_attachment_never_pass(self):
        self.test["expectedStatus"] = "failed"
        self.assertEqual(self.observed()["status"], "unknown")
        self.test["expectedStatus"] = "passed"
        self.report["errors"] = [{"message": "harness error"}]
        self.assertEqual(self.observed()["status"], "unknown")
        self.report["errors"] = []
        self.test["results"][0]["attachments"] = []
        self.assertEqual(self.observed()["status"], "unknown")

    def test_inventory_and_observation_source_are_required(self):
        for inventory in ({"floorplans": {}}, {"floorplans": []}):
            with self.assertRaises(ValueError): producer.rows(inventory, [self.report])
        self.report["suites"][0]["specs"][0]["file"] = "other/screens.spec.ts"
        self.assertTrue(all(row["status"] == "unknown" for row in self.rows()))

    def test_bad_observations_are_refused(self):
        for key, value in (("route", "/forged"), ("state", "skipped"), ("status", "skipped"),
                           ("reference_count", True), ("floorplan", 1), ("raw_server_text", "false")):
            with self.subTest(key=key):
                original = deepcopy(self.observation)
                self.observation[key] = value
                self.attach()
                with self.assertRaises(ValueError): self.rows()
                self.observation = original
        self.attach()
        self.test["results"][0]["attachments"][0].pop("body")
        with self.assertRaisesRegex(ValueError, "inline"): self.rows()

    def test_support_reference_source_is_reused(self):
        self.report["suites"][0]["specs"][0]["file"] = "states/support-ref-failed-a.spec.ts"
        self.observation.update(state="failed", support_ref="a" * 32, reference_count=1)
        self.attach()
        self.test["results"][0]["attachments"][0]["name"] = "support-reference"
        row = next(r for r in self.rows() if r["route"] == "/" and r["state"] == "failed")
        self.assertEqual(row["status"], "pass")
        self.assertEqual(row["support_ref"], "a" * 32)
        self.assertEqual(row["kind"], "support-reference")

    def test_cli_writes_envelope_on_red_without_refreshing_time(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inventory, report, artifact = (root / name for name in ("inventory.json", "report.json", "states.json"))
            inventory.write_text(json.dumps(self.inventory))
            command = [sys.executable, producer.__file__, str(artifact), str(inventory), str(report)]
            for status, expected in (("passed", "pass"), ("failed", "fail")):
                self.test["results"][0]["status"] = status
                report.write_text(json.dumps(self.report))
                result = subprocess.run(command, capture_output=True, text=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                data = json.loads(artifact.read_text())
                observed = next(row for row in data["rows"] if row["route"] == "/" and row["state"] == "empty")
                self.assertEqual(observed["status"], expected)
                self.assertEqual(data["run_at"], self.report["stats"]["startTime"])
                self.assertEqual(data["commit"], subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip())
                self.assertTrue(data["source_command"])
                self.assertNotIn(directory, data["source_command"])
            self.report["config"]["metadata"]["commit"] = "0" * 40
            report.write_text(json.dumps(self.report))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("commit", result.stderr)
            self.report["config"]["metadata"]["commit"] = data["commit"]
            self.report["stats"]["startTime"] = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
            report.write_text(json.dumps(self.report))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)
            report.write_text("{")
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("states evidence:", result.stderr)


if __name__ == "__main__": unittest.main()

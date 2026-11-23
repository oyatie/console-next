# SPDX-License-Identifier: LicenseRef-Proprietary
"""Synthetic report controls for support-reference evidence."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

spec = importlib.util.spec_from_file_location("producer", Path(__file__).with_name("d8-evidence.py"))
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


class SupportEvidenceTest(unittest.TestCase):
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
            now = datetime.now(timezone.utc).isoformat()
            sample = {"stats": {"startTime": now}, "suites": []}
            report = root / "report.json"
            report.write_text(json.dumps(sample))
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
            envelope = {"commit": commit, "run_at": now, "source_command": "synthetic report",
                        "rows": [{"kind": "client-errors", "title": "beacon", "browser": "chromium", "status": "pass"}]}
            (root / "e2e.json").write_text(json.dumps(envelope))
            command = [sys.executable, producer.__file__, str(root / "out"), str(root / "e2e.json"), str(report)]
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual({file.name for file in (root / "out").iterdir()}, {"e2e.json", "write-probe.json"})
            data = json.loads((root / "out/e2e.json").read_text())
            self.assertEqual(data["commit"], commit)
            self.assertEqual(data["run_at"], now)
            self.assertNotIn(directory, data["source_command"])
            self.assertEqual(data["rows"][0]["status"], "pass")
            self.assertEqual(json.loads((root / "out/e2e.json").read_text())["rows"], envelope["rows"])
            sample["stats"]["startTime"] = (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()
            report.write_text(json.dumps(sample))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)
            report.write_text(json.dumps({**sample, "stats": {"startTime": now}}))
            (root / "e2e.json").write_text(json.dumps({**envelope, "run_at": (datetime.now(timezone.utc) - timedelta(days=9)).isoformat()}))
            result = subprocess.run(command, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("stale", result.stderr)
            (root / "e2e.json").write_text(json.dumps({**envelope, "commit": "0" * 40}))
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()

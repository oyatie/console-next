# SPDX-License-Identifier: LicenseRef-Proprietary
"""Normalize live support-reference lookups from Playwright reports."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("d10", Path(__file__).with_name("d10-evidence.py"))
d10 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d10)


def resolved(row):
    return (row["status"] == "pass" and row["http_status"] == 403 and bool(row.get("support_ref"))
            and row.get("ops_http_status") == 200 and row.get("ops_support_ref") == row["support_ref"])


def main():
    if len(sys.argv) < 4: raise ValueError("usage: d8-evidence.py OUTPUT_DIR E2E_JSON PLAYWRIGHT_JSON...")
    output, e2e_file, *files = sys.argv[1:]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    e2e = json.loads(Path(e2e_file).read_text())
    if e2e["commit"] != commit: raise ValueError("E2E evidence commit differs from checkout")
    reports = [json.loads(Path(file).read_text()) for file in files]
    dates = [d10.d7.fresh(e2e["run_at"])] + [d10.d7.fresh(r["stats"]["startTime"]) for r in reports]
    probes = [p for report in reports for p in d10.probe_rows(report)]
    data = {"commit": commit, "run_at": min(dates), "source_command": "python3 scripts/d8-evidence.py OUTPUT_DIR E2E_JSON PLAYWRIGHT_JSON..."}
    artifacts = {"e2e": e2e["rows"],
                 "write-probe": [{**p, "ops_resolved": resolved(p)} for p in probes]}
    Path(output).mkdir(parents=True, exist_ok=True)
    for name, rows in artifacts.items():
        Path(output, name + ".json").write_text(json.dumps({**data, "rows": rows}, indent=2) + "\n")


if __name__ == "__main__":
    try: main()
    except (ValueError, KeyError, OSError) as error: sys.exit(f"D8 evidence: {error}")

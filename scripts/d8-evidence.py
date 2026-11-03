# SPDX-License-Identifier: LicenseRef-Proprietary
"""Normalize support-reference observations from built-in Playwright JSON reports."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("d10", Path(__file__).with_name("d10-evidence.py"))
d10 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d10)

SUPPORT_REF_SPECS = {
    f"states/support-ref-{state}-{part}.spec.ts"
    for state in ("failed", "refused", "no-reference") for part in ("a", "b")
}


def state_rows(report):
    rows = []

    def walk(suite):
        for entry in suite.get("specs", []):
            file = entry.get("file", "").replace("\\", "/").split("/e2e/")[-1].removeprefix("e2e/")
            if file not in SUPPORT_REF_SPECS: continue
            for test in entry["tests"]:
                results = test.get("results", [])
                states = [d10.d7.status(r["status"]) for r in results]
                status = "fail" if "fail" in states else "pass" if states and all(s == "pass" for s in states) else "unknown"
                if report.get("errors") or test.get("expectedStatus") != "passed": status = "unknown"
                for result in results:
                    for attachment in result.get("attachments", []):
                        if attachment["name"] != "support-reference": continue
                        if attachment.get("contentType") != "application/json" or "body" not in attachment:
                            raise ValueError("support-reference requires an inline JSON attachment")
                        row = json.loads(base64.b64decode(attachment["body"], validate=True))
                        observed = row.get("status", "unknown")
                        if observed not in ("pass", "fail", "unknown"): raise ValueError("invalid state observation status")
                        rows.append({**row, "status": status if status != "pass" else observed})
        for child in suite.get("suites", []): walk(child)

    for suite in report["suites"]: walk(suite)
    return rows


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
    artifacts = {"e2e": e2e["rows"], "states": [r for report in reports for r in state_rows(report)],
                 "write-probe": [{**p, "ops_resolved": resolved(p)} for p in probes]}
    Path(output).mkdir(parents=True, exist_ok=True)
    for name, rows in artifacts.items():
        Path(output, name + ".json").write_text(json.dumps({**data, "rows": rows}, indent=2) + "\n")


if __name__ == "__main__":
    try: main()
    except (ValueError, KeyError, OSError) as error: sys.exit(f"D8 evidence: {error}")

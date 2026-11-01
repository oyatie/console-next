# SPDX-License-Identifier: LicenseRef-Proprietary
"""Join the access census and test reports; unprobed writes remain unknown."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("d7", Path(__file__).with_name("d7-evidence.py"))
d7 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d7)


def probe_rows(report):
    rows = []

    def walk(suite):
        for entry in suite.get("specs", []):
            for test in entry["tests"]:
                for result in test.get("results", []):
                    for attachment in result.get("attachments", []):
                        if attachment["name"] != "write-probe": continue
                        if attachment.get("contentType") != "application/json" or "body" not in attachment:
                            raise ValueError("write-probe requires an inline JSON attachment")
                        data = json.loads(base64.b64decode(attachment["body"], validate=True))
                        http, control = data.get("http_status"), data.get("control_http_status")
                        valid = (data.get("principal") == "no-grant" and type(http) is int and type(control) is int
                                 and 200 <= control < 500 and control not in (401, 403)
                                 and test["expectedStatus"] == "passed" and not report.get("errors"))
                        state = "unknown"
                        if valid:
                            if 200 <= http < 300: state = "fail"
                            elif http == 403:
                                states = [d7.status(r["status"]) for r in test["results"]]
                                state = "fail" if "fail" in states else "pass" if all(s == "pass" for s in states) else "unknown"
                        rows.append({"operation": data["operation"], "status": state,
                                     "principal": data.get("principal", "unknown"), "http_status": http, "control_http_status": control,
                                     "title": "e2e/" + entry.get("file", "").replace("\\", "/").split("/e2e/")[-1].removeprefix("e2e/") + " › " + entry["title"]})
        for child in suite.get("suites", []): walk(child)

    for suite in report["suites"]: walk(suite)
    return rows


def authorization_rows(census, probes, refusals=()):
    rows = []
    for entry in census:
        found = [p for p in probes if p["operation"] == entry["operation"]]
        passed = bool(found) and all(p["status"] == "pass" for p in found)
        rows.append({**entry, "status": "pass" if passed else "fail" if any(p["status"] == "fail" for p in found) else "unknown",
                     "negative_test": passed, "tests": found,
                     "refusal_tests": [r for r in refusals if r.get("operation") == entry["operation"]]})
    return rows


def main():
    if len(sys.argv) < 5: raise ValueError("usage: d10-evidence.py OUTPUT_DIR CENSUS_JSON D7_DIR PLAYWRIGHT_JSON...")
    output, census_file, d7_dir, *files = sys.argv[1:]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    reports = [json.loads(Path(file).read_text()) for file in files]
    dates = [d7.fresh(r["stats"]["startTime"]) for r in reports]
    refusals = []
    for name in ("e2e", "nextest"):
        data = json.loads(Path(d7_dir, name + ".json").read_text())
        if data["commit"] != commit: raise ValueError("D7 evidence commit differs from checkout")
        dates.append(d7.fresh(data["run_at"]))
        refusals.extend(r for r in data["rows"] if "operation" in r)
    rows = authorization_rows(json.loads(Path(census_file).read_text()),
                              [p for report in reports for p in probe_rows(report)], refusals)
    data = {"commit": commit, "run_at": min(dates), "source_command": "node scripts/d10-census.mjs; python3 scripts/d10-evidence.py OUTPUT_DIR CENSUS_JSON D7_DIR PLAYWRIGHT_JSON...", "rows": rows}
    Path(output).mkdir(parents=True, exist_ok=True)
    Path(output, "authorization.json").write_text(json.dumps(data, indent=2) + "\n")


if __name__ == "__main__":
    try: main()
    except (ValueError, KeyError, OSError) as error: sys.exit(f"D10 evidence: {error}")

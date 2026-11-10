# SPDX-License-Identifier: LicenseRef-Proprietary
"""Normalize built-in Playwright JSON and nextest JUnit for screens/evidence.py."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
import xml.etree.ElementTree as ET

MAX_AGE_DAYS = 7


def fresh(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)", value):
        raise ValueError("expected UTC RFC 3339 report timestamp")
    age = datetime.now(timezone.utc) - datetime.fromisoformat(value.replace("Z", "+00:00"))
    if not timedelta(0) <= age <= timedelta(days=MAX_AGE_DAYS):
        raise ValueError(f"stale or future report refused (maximum age: {MAX_AGE_DAYS} days)")
    return value


def status(result):
    return "pass" if result == "passed" else "fail" if result in ("failed", "timedOut") else "unknown"


def e2e_rows(report, index):
    fresh(report["stats"]["startTime"])
    rows = []

    def failure(step):
        for child in step.get("steps", []):
            found = failure(child)
            if found: return found
        return step["title"] if step.get("error") else None

    def walk(suite, groups):
        for spec in suite.get("specs", []):
            file = spec.get("file", suite.get("file", "")).replace("\\", "/")
            file = "e2e/" + file.split("/e2e/")[-1].removeprefix("e2e/")
            title = " › ".join(groups + [spec["title"]])
            for test in spec["tests"]:
                browser = {"parallel": "chromium", "clock": "chromium", "firefox": "firefox"}.get(test["projectName"], "unknown")
                if test["projectName"] == "" and report.get("config", {}).get("configFile", "").endswith("e2e/mock/playwright.config.ts"):
                    browser = "chromium"
                for result in test.get("results", []) or [{"status": "skipped"}]:
                    state = status(result["status"]) if test.get("expectedStatus") == "passed" and not report.get("errors") else "unknown"
                    if file == "e2e/error-beacon.spec.ts":
                        rows.append({"kind": "client-errors", "title": title, "browser": browser, "status": state})

                    def steps(items):
                        for step in items:
                            if re.match(r"^J\d+ ", step["title"]):
                                failed = failure(step)
                                done = "fail" if failed else "pass" if "duration" in step and result["status"] in ("passed", "failed", "timedOut") else "unknown"
                                if report.get("errors") or test.get("expectedStatus") != "passed": done = "unknown"
                                rows.append({"kind": "journey", "step": step["title"], "title": title + (" › " + failed if failed else ""), "browser": browser, "status": done})
                            steps(step.get("steps", []))
                    if file == "e2e/first-run-solo.spec.ts": steps(result.get("steps", []))
                    for entry in index:
                        if any(a["file"] == file and a["title"] == title for a in entry["ui"]):
                            rows.append({"kind": "refusal", "operation": entry["operation"], "code": entry["code"], "title": title, "browser": browser, "status": state})
        for child in suite.get("suites", []):
            walk(child, groups + [child["title"]])

    for suite in report["suites"]: walk(suite, [])
    return rows


def nextest_rows(xml, index):
    try: root = ET.fromstring(xml)
    except ET.ParseError as error: raise ValueError("invalid nextest JUnit") from error
    if root.tag != "testsuites": raise ValueError("expected nextest testsuites root")
    cases = list(root.iter("testcase"))
    rows = []
    for entry in index:
        for assertion in entry["be"]:
            found = [c for c in cases if c.get("classname") == assertion["binary"] and c.get("name") == assertion["title"]]
            for case in found:
                names = {tag.tag for tag in case.iter()}
                declarations = [a for a in entry["be"] if (a["binary"], a["title"]) == (assertion["binary"], assertion["title"])]
                state = "fail" if names & {"failure", "error", "rerunFailure", "flakyFailure", "rerunError", "flakyError"} else "unknown" if "skipped" in names or len(found) != 1 or len(declarations) != 1 else "pass"
                rows.append({"operation": entry["operation"], "code": entry["code"], "title": case.get("classname") + " › " + case.get("name"), "status": state})
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", choices=("e2e", "nextest"))
    parser.add_argument("output")
    parser.add_argument("reports", nargs="+")
    args = parser.parse_args()
    files = args.reports
    if not args.source and len(files) < 2: raise ValueError("nextest JUnit and Playwright JSON required")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    index = json.loads(subprocess.check_output(["node", "scripts/negative-index.mjs"], text=True))
    envelopes = {}
    if args.source != "nextest":
        reports = [json.loads(Path(file).read_text()) for file in (files if args.source else files[1:])]
        envelopes["e2e"] = {"run_at": min(fresh(r["stats"]["startTime"]) for r in reports),
                            "rows": [row for r in reports for row in e2e_rows(r, index)]}
    if args.source != "e2e":
        paths = [path for file in (files if args.source else files[:1])
                 for path in (sorted(Path(file).rglob("junit.xml")) if Path(file).is_dir() else [Path(file)])]
        if not paths: raise ValueError("nextest JUnit required")
        xmls = [file.read_text() for file in paths]
        roots = [ET.fromstring(xml) for xml in xmls]
        # Preserve each shard's proof time; copying an old artifact cannot refresh it.
        times = [[fresh(e.get("timestamp")) for e in root.iter() if e.tag in ("testsuites", "testsuite") and e.get("timestamp")] for root in roots]
        if any(not timestamps for timestamps in times): raise ValueError("nextest JUnit timestamp required for every shard")
        envelopes["nextest"] = {"run_at": min(timestamp for shard in times for timestamp in shard),
                                "rows": [row for xml in xmls for row in nextest_rows(xml, index)]}
    source = "python3 scripts/d7-evidence.py " + (f"--source {args.source} OUTPUT_DIR REPORT..." if args.source else "OUTPUT_DIR NEXTEST_JUNIT PLAYWRIGHT_JSON...")
    Path(args.output).mkdir(parents=True, exist_ok=True)
    for name, data in envelopes.items():
        Path(args.output, name + ".json").write_text(json.dumps({"commit": commit, "source_command": source, **data}, indent=2) + "\n")


if __name__ == "__main__":
    try: main()
    except (ValueError, KeyError, OSError, ET.ParseError) as error: sys.exit(f"D7 evidence: {error}")

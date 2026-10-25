#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""No-new-reds: execute every test, then account for exact, owned baseline IDs."""
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
CONFIG = json.loads((ROOT / "scripts/ci/config.json").read_text())


KEY_FIELDS = ("kind", "context", "suite", "test")


def key(entry):
    return tuple(entry[field] for field in KEY_FIELDS)


def receipts(entry):
    evidence = entry.get("evidence", [])
    ids = set()
    for run in evidence:
        if (not isinstance(run.get("runId"), str) or not run["runId"].strip()
                or run["runId"] in ids or run.get("result") not in ("passed", "failed")
                or datetime.date.fromisoformat(run["date"]) > datetime.date.today()):
            raise ValueError("invalid baseline run evidence")
        ids.add(run["runId"])
    return evidence


def baseline(file):
    entries = json.loads(file.read_text())
    ids = {}
    for entry in entries:
        if (any(not isinstance(entry.get(field), str) or not entry[field].strip()
                for field in ("kind", "context", "suite", "test", "owner", "expires"))
                or datetime.date.fromisoformat(entry["expires"]) <= datetime.date.today()
                or key(entry) in ids
                or entry.get("class", "deterministic") not in ("deterministic", "flaky")
                or (entry["kind"] == "playwright" and "first-run-solo.spec.ts" in entry["suite"])):
            raise ValueError("invalid, duplicate or expired baseline entry")
        evidence = receipts(entry)
        if entry.get("class") == "flaky":
            if ({run["result"] for run in evidence} != {"passed", "failed"}
                    or (datetime.date.fromisoformat(entry["expires"]) - datetime.date.fromisoformat(max(run["date"] for run in evidence))).days > CONFIG["baselineFlakyDays"]):
                raise ValueError("flaky baseline needs disagreeing runs and a short expiry")
        ids[key(entry)] = entry
    flaky = sum(entry.get("class") == "flaky" for entry in entries)
    if flaky > CONFIG["baselineMaxFlaky"]:
        raise ValueError("flaky baseline budget exceeded")
    return ids


def validate_changes(entries, previous):
    old = {key(entry): entry for entry in previous}
    today = datetime.date.today()
    for entry in entries:
        prior = old.get(key(entry))
        if prior is None or any(entry[field] != prior[field] for field in (*KEY_FIELDS, "owner")):
            raise ValueError("strict baseline may only shrink; identity and ownership may not change")
        if entry.get("class", "deterministic") != prior.get("class", "deterministic"):
            evidence = receipts(entry)
            if (entry.get("class") != "flaky" or {run["result"] for run in evidence} != {"passed", "failed"}
                    or datetime.date.fromisoformat(entry["expires"]) > today + datetime.timedelta(days=CONFIG["baselineFlakyDays"])):
                raise ValueError("a flaky reclassification needs disagreeing runs and a short expiry")
        evidence = receipts(entry)
        old_runs = prior.get("evidence", [])
        if any(run not in evidence for run in old_runs):
            raise ValueError("baseline evidence may only grow")
        new_runs = [run for run in evidence if run["runId"] not in {old["runId"] for old in old_runs}]
        expires, was = datetime.date.fromisoformat(entry["expires"]), datetime.date.fromisoformat(prior["expires"])
        if expires > was:
            days = CONFIG["baselineFlakyDays"] if entry.get("class") == "flaky" else CONFIG["baselineRenewalDays"]
            if (expires > min(was, today) + datetime.timedelta(days=days)
                    or not any(run["date"] == today.isoformat() and (entry.get("class") == "flaky" or run["result"] == "failed") for run in new_runs)):
                raise ValueError("baseline extension needs fresh run evidence within the renewal limit")


def check(kind, context, file, status, entries):
    # Only the test-failure exit codes are eligible; infrastructure errors stay red.
    if kind not in ("playwright", "nextest") or status not in ((0, 1) if kind == "playwright" else (0, 100)):
        raise ValueError("test runner did not complete")
    root = ET.parse(file).getroot()
    cases = list(root.iter("testcase"))
    # Playwright emits case-level errors for test timeouts; runner/worker errors stay fatal.
    timeouts = {error for case in cases for error in case.findall("error")
                if kind == "playwright" and re.fullmatch(r"Test timeout of [1-9][0-9]*ms exceeded\.", error.get("message", ""))}
    empty_group = kind == "nextest" and status == 0 and root.tag == "testsuites" and root.get("tests") == "0" and root.get("failures", "0") == "0"
    if ((not cases and not empty_group) or any(error not in timeouts for error in root.iter("error"))
            or any(int(node.get("errors", "0")) > len(timeouts) for node in root.iter())):
        raise ValueError("missing tests or test infrastructure error")
    failed = [case for case in cases if case.find("failure") is not None or case.find("error") in timeouts]
    if (status == 0 and failed) or max((int(node.get("failures", "0")) for node in root.iter()), default=0) > len(failed):
        raise ValueError("JUnit failures do not match the completed run")
    if status and not failed:
        raise ValueError("runner failed without accounted test failures")
    def case_key(case):
        suite = case.get("classname", "")
        if kind == "playwright":
            suite = suite.replace("\\", "/").removeprefix("e2e/")
        return (kind, context, suite, re.sub(r"(?: @[\w-]+)+$", "", case.get("name", "")))
    ids = {case_key(case) for case in failed}
    passed = {case_key(case) for case in cases if case.find("failure") is None and case.find("error") is None and case.find("skipped") is None}
    fresh = ids - set(entries)
    strict = {ident for ident, entry in entries.items() if entry.get("class", "deterministic") == "deterministic"}
    fixed = passed & strict
    # Only this shard's executed cases can recover; inventory checks catch deleted tests.
    report = {"tests": len(cases), "baselineReds": sorted(ids & set(entries)), "newReds": sorted(fresh), "fixed": sorted(fixed), "passed": sorted(passed)}
    file.with_suffix(".baseline.json").write_text(json.dumps(report))
    print(f"test baseline: {len(cases)} tests, {len(ids & set(entries))} known reds, {len(fresh)} new reds, {len(fixed)} fixed")
    if fixed:
        print("test baseline: fixed tests; remove from baseline")
    return 1 if fresh or fixed else 0


def inventory(kind, context, report, entries):
    if kind == "nextest":
        present = {(kind, context, suite, name) for suite, value in report["rust-suites"].items() for name in value["testcases"]}
    elif kind == "playwright":
        present = set()
        def walk(suite, file, titles):
            for spec in suite.get("specs", []):
                title = re.sub(r"(?: @[\w-]+)+$", "", " › ".join([*titles, spec["title"]]))
                present.add((kind, context, file, title))
            for child in suite.get("suites", []):
                walk(child, file, [*titles, child["title"]])
        for suite in report["suites"]:
            walk(suite, suite["file"].replace("\\", "/").removeprefix("e2e/"), [])
    else:
        raise ValueError("unknown test inventory")
    packages = json.loads(os.environ.get("CI_BASELINE_CRATES", "null"))
    expected = {entry for entry in entries if entry[:2] == (kind, context)
                and (kind != "nextest" or packages is None or entry[2].split("::")[0] in packages)}
    absent = expected - present
    if absent:
        print(f"test baseline: {len(absent)} absent tests; remove from baseline")
        raise ValueError("baseline test no longer exists")



if __name__ == "__main__":
    try:
        config = json.loads((ROOT / "scripts/ci/config.json").read_text())
        file = ROOT / config["quarantineFile"]
        if sys.argv[1:] == ["--validate"]:
            entries = baseline(file)
            base = subprocess.check_output(["node", str(ROOT / "scripts/git-base.mjs")], cwd=ROOT, text=True).strip()
            if base:
                prior_config = subprocess.run(["git", "show", f"{base}:scripts/ci/config.json"], cwd=ROOT, capture_output=True)
                old_path = json.loads(prior_config.stdout).get("quarantineFile") if prior_config.returncode == 0 else None
                if old_path and old_path != config["quarantineFile"]:
                    raise ValueError("baseline path may not change")
                previous = subprocess.run(["git", "show", f"{base}:{config['quarantineFile']}"],
                                          cwd=ROOT, capture_output=True)
                if previous.returncode == 0:
                    validate_changes(json.loads(file.read_text()), json.loads(previous.stdout))
                elif old_path or subprocess.run(["git", "cat-file", "-e", f"{base}^{{commit}}"],
                                    cwd=ROOT, capture_output=True).returncode:
                    raise ValueError("baseline base commit unavailable")
            flaky = sum(entry.get("class") == "flaky" for entry in entries.values())
            print(f"test baseline: {len(entries)} owned, unexpired entries; {flaky}/{CONFIG['baselineMaxFlaky']} flaky")
            for entry in entries.values():
                if (datetime.date.fromisoformat(entry["expires"]) - datetime.date.today()).days <= 7:
                    print(f"::warning::Baseline expiry D-7: {entry['owner']} / {entry['suite']} / {entry['expires']}")
        elif sys.argv[1:2] == ["--inventory"]:
            _, kind, context, source, *custom = sys.argv[1:]
            inventory(kind, context, json.loads(Path(source).read_text()), baseline(Path(custom[0]) if custom else file))
        else:
            kind, context, junit, status, *custom = sys.argv[1:]
            entries = baseline(Path(custom[0]) if custom else file)
            sys.exit(check(kind, context, Path(junit), int(status), entries))
    except Exception:
        print("test baseline: invalid policy or incomplete JUnit proof", file=sys.stderr)
        sys.exit(1)

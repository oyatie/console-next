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


def key(entry):
    return tuple(entry[field] for field in ("kind", "context", "suite", "test"))


def baseline(file):
    entries = json.loads(file.read_text())
    ids = set()
    for entry in entries:
        if (any(not isinstance(entry.get(field), str) or not entry[field].strip()
                for field in ("kind", "context", "suite", "test", "owner", "expires"))
                or datetime.date.fromisoformat(entry["expires"]) <= datetime.date.today()
                or key(entry) in ids):
            raise ValueError("invalid, duplicate or expired baseline entry")
        ids.add(key(entry))
    return ids


def check(kind, context, file, status, entries):
    # Only the test-failure exit codes are eligible; infrastructure errors stay red.
    if kind not in ("playwright", "nextest") or status not in ((0, 1) if kind == "playwright" else (0, 100)):
        raise ValueError("test runner did not complete")
    root = ET.parse(file).getroot()
    cases = list(root.iter("testcase"))
    empty_group = kind == "nextest" and status == 0 and root.tag == "testsuites" and root.get("tests") == "0" and root.get("failures", "0") == "0"
    if (not cases and not empty_group) or list(root.iter("error")) or any(int(node.get("errors", "0")) for node in root.iter()):
        raise ValueError("missing tests or test infrastructure error")
    failed = [case for case in cases if case.find("failure") is not None]
    if (status == 0 and failed) or max((int(node.get("failures", "0")) for node in root.iter()), default=0) > len(failed):
        raise ValueError("JUnit failures do not match the completed run")
    if status and not failed:
        raise ValueError("runner failed without accounted test failures")
    ids = set()
    for case in failed:
        suite = case.get("classname", "")
        if kind == "playwright":
            suite = suite.replace("\\", "/").removeprefix("e2e/")
        title = re.sub(r"(?: @[\w-]+)+$", "", case.get("name", ""))
        ids.add((kind, context, suite, title))
    fresh = ids - entries
    # The report contains IDs only; failure text stays behind the upload scan.
    report = {"tests": len(cases), "baselineReds": sorted(ids & entries), "newReds": sorted(fresh)}
    file.with_suffix(".baseline.json").write_text(json.dumps(report))
    print(f"test baseline: {len(cases)} tests, {len(ids & entries)} known reds, {len(fresh)} new reds")
    return 1 if fresh else 0


if __name__ == "__main__":
    try:
        config = json.loads((ROOT / "scripts/ci/config.json").read_text())
        file = ROOT / config["quarantineFile"]
        if sys.argv[1:] == ["--validate"]:
            entries = baseline(file)
            base = os.environ.get("CI_BASE_SHA")
            if base:
                prior_config = subprocess.run(["git", "show", f"{base}:scripts/ci/config.json"], cwd=ROOT, capture_output=True)
                old_path = json.loads(prior_config.stdout).get("quarantineFile") if prior_config.returncode == 0 else None
                if old_path and old_path != config["quarantineFile"]:
                    raise ValueError("baseline path may not change")
                previous = subprocess.run(["git", "show", f"{base}:{config['quarantineFile']}"],
                                          cwd=ROOT, capture_output=True)
                if previous.returncode == 0:
                    old = {key(entry): entry for entry in json.loads(previous.stdout)}
                    for entry in json.loads(file.read_text()):
                        prior = old.get(key(entry))
                        if prior is None or entry != prior:
                            raise ValueError("baseline may only shrink")
                elif old_path or subprocess.run(["git", "cat-file", "-e", f"{base}^{{commit}}"],
                                    cwd=ROOT, capture_output=True).returncode:
                    raise ValueError("baseline base commit unavailable")
            print(f"test baseline: {len(entries)} owned, unexpired entries")
        else:
            kind, context, junit, status, *custom = sys.argv[1:]
            entries = baseline(Path(custom[0]) if custom else file)
            sys.exit(check(kind, context, Path(junit), int(status), entries))
    except Exception:
        print("test baseline: invalid policy or incomplete JUnit proof", file=sys.stderr)
        sys.exit(1)

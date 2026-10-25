#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-Proprietary
"""Compare completed DB partitions from this run's independently built sources."""
import importlib.util
import json
import os
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("results", ROOT / "scripts/ci/test-results.py")
results = importlib.util.module_from_spec(spec)
spec.loader.exec_module(results)


def provenance():
    env = os.environ
    values = {"runId": env["GITHUB_RUN_ID"], "attempt": env["GITHUB_RUN_ATTEMPT"],
              "baseSha": env["CI_BASE_SHA"], "headSha": env["CI_HEAD_SHA"]}
    if (any(not values[key].isdigit() or int(values[key]) < 1 for key in ("runId", "attempt"))
            or any(not re.fullmatch(r"[a-f0-9]{40}", values[key]) for key in ("baseSha", "headSha"))):
        raise ValueError("invalid hosted run provenance")
    return values


def record(junit, status, partition, partitions):
    source = os.environ["CI_HOSTED_SOURCE"]
    receipt = provenance()
    if (source not in ("base", "head") or not 1 <= partition <= partitions
            or os.environ["CI_SOURCE_SHA"] != receipt[f"{source}Sha"]):
        raise ValueError("invalid hosted source provenance")
    # Validate runner completion and JUnit, without granting a policy exception.
    results.check("nextest", "db", junit, status, {})
    report = json.loads(junit.with_suffix(".baseline.json").read_text())
    report.update(receipt, comparisonPending=True, source=source, sha=os.environ["CI_SOURCE_SHA"],
                  partition=partition, partitions=partitions)
    junit.with_suffix(".baseline.json").write_text(json.dumps(report))
    return report


def compare(directory, partitions, policy):
    expected = provenance()
    seen = set()
    failed, passed = {"base": set(), "head": set()}, {"base": set(), "head": set()}
    for file in directory.glob("*/junit.baseline.json"):
        report = json.loads(file.read_text())
        source, partition = report["source"], report["partition"]
        if (source not in failed or any(report[key] != value for key, value in expected.items())
                or report["sha"] != expected[f"{source}Sha"] or report["partitions"] != partitions
                or not 1 <= partition <= partitions or (source, partition) in seen):
            raise ValueError("stale, duplicate or mismatched hosted DB receipt")
        seen.add((source, partition))
        for field, target in (("newReds", failed), ("passed", passed)):
            ids = {tuple(ident) for ident in report[field]}
            if (any(len(ident) != 4 or ident[:2] != ("nextest", "db") for ident in ids)
                    or ids & target[source]):
                raise ValueError("invalid or duplicate partition test IDs")
            target[source].update(ids)
    if seen != {(source, partition) for source in failed for partition in range(1, partitions + 1)}:
        print("hosted DB: missing base/head partition evidence")
        return 1
    if any(failed[source] & passed[source] for source in failed):
        raise ValueError("contradictory hosted DB results")
    entries = results.baseline(policy)
    standing = failed["head"] & failed["base"]
    fresh = failed["head"] - failed["base"]
    unowned = standing - entries.keys()
    fixed = passed["head"] & {ident for ident, entry in entries.items() if entry.get("class", "deterministic") == "deterministic"}
    report = {"provenance": expected, "baselineReds": sorted(standing), "newReds": sorted(fresh),
              "unowned": sorted(unowned), "fixed": sorted(fixed)}
    (directory / "comparison.json").write_text(json.dumps(report))
    print(f"hosted DB: {len(standing)} standing, {len(fresh)} new, {len(unowned)} unowned, {len(fixed)} fixed")
    return int(bool(fresh or unowned or fixed))


if __name__ == "__main__":
    try:
        config = results.CONFIG
        if sys.argv[1] == "record":
            _, _, junit, status, partition = sys.argv
            record(Path(junit), int(status), int(partition), config["nextestPartitions"]["db"])
            sys.exit(0)
        if sys.argv[1:] != ["compare"]:
            raise ValueError("unknown hosted DB command")
        sys.exit(compare(ROOT / ".cache/ci/db-collected", config["nextestPartitions"]["db"], ROOT / config["quarantineFile"]))
    except Exception:
        print("hosted DB: incomplete or invalid current-run evidence", file=sys.stderr)
        sys.exit(1)

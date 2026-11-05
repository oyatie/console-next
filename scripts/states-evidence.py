# SPDX-License-Identifier: LicenseRef-Proprietary
"""Produce route-state evidence from the existing mocked Playwright matrix."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

spec = importlib.util.spec_from_file_location("d8", Path(__file__).with_name("d8-evidence.py"))
d8 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d8)
d7 = d8.d10.d7
STATES = ("loading", "failed", "empty", "refused")


def observations(report):
    result = [{**row, "kind": "support-reference"} for row in d8.state_rows(report)]

    def walk(suite):
        for entry in suite.get("specs", []):
            file = entry.get("file", "").replace("\\", "/").split("/e2e/")[-1].removeprefix("e2e/")
            if file != "states/screens.spec.ts": continue
            for test in entry["tests"]:
                attempts = [d7.status(r["status"]) for r in test.get("results", [])]
                status = "fail" if "fail" in attempts else "pass" if attempts and all(s == "pass" for s in attempts) else "unknown"
                if report.get("errors") or test.get("expectedStatus") != "passed": status = "unknown"
                for attempt in test.get("results", []):
                    for attachment in attempt.get("attachments", []):
                        if attachment["name"] != "screen-state": continue
                        if attachment.get("contentType") != "application/json" or "body" not in attachment:
                            raise ValueError("screen-state requires an inline JSON attachment")
                        row = json.loads(base64.b64decode(attachment["body"], validate=True))
                        result.append({**row, "kind": "screen-state", "status": row["status"] if status == "pass" else status})
        for child in suite.get("suites", []): walk(child)

    for suite in report["suites"]: walk(suite)
    return result


def rows(inventory, reports):
    floorplans = inventory["floorplans"]
    if not isinstance(floorplans, dict) or not floorplans: raise ValueError("app route inventory required")
    floorplans = {**dict.fromkeys(route for module in inventory.get("modules", []) for route in module["routes"]), **floorplans}
    result = []
    for report in reports:
        d7.fresh(report["stats"]["startTime"])
        for row in observations(report):
            if row.get("route") not in floorplans:
                raise ValueError("observation route is absent from route inventory")
            if row.get("state") not in (*STATES, "no-reference") or row.get("status") not in ("pass", "fail", "unknown"):
                raise ValueError("invalid state or status")
            schema = {"support_ref": (str, type(None)), "reference_count": int, "raw_server_text": bool, "floorplan": (str, type(None))}
            for key, kind in schema.items():
                if key not in row or not isinstance(row[key], kind) or (key == "reference_count" and (type(row[key]) is not int or row[key] < 0)):
                    raise ValueError("invalid " + key)
            result.append({**row, "declared_floorplan": floorplans[row["route"]]})
    measured = {(row["route"], row["state"]) for row in result}
    for route, floorplan in floorplans.items():
        for state in STATES:
            if (route, state) not in measured:
                result.append({"route": route, "state": state, "kind": "screen-state", "status": "unknown", "reason": "no executed observation",
                               "support_ref": None, "reference_count": 0, "raw_server_text": False,
                               "floorplan": None, "declared_floorplan": floorplan})
    return sorted(result, key=lambda row: (row["route"], row["state"]))


def main():
    if len(sys.argv) < 4: raise ValueError("usage: states-evidence.py OUTPUT_JSON ROUTES_JSON PLAYWRIGHT_JSON...")
    output, inventory, *files = sys.argv[1:]
    reports = [json.loads(Path(file).read_text()) for file in files]
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if any(report.get("config", {}).get("metadata", {}).get("commit") != commit for report in reports):
        raise ValueError("report commit differs from checkout or is missing")
    data = {"commit": commit,
            "run_at": min(d7.fresh(r["stats"]["startTime"]) for r in reports),
            "source_command": "npm run e2e:states; python3 scripts/states-evidence.py OUTPUT_JSON ROUTES_JSON PLAYWRIGHT_JSON...",
            "rows": rows(json.loads(Path(inventory).read_text()), reports)}
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    counts = {status: sum(row["status"] == status for row in data["rows"]) for status in ("pass", "fail", "unknown")}
    print(json.dumps(counts))
    return int(bool(counts["fail"]))


if __name__ == "__main__":
    try: sys.exit(main())
    except (ValueError, KeyError, OSError) as error: sys.exit(f"states evidence: {error}")

// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";

const workflow = load(readFileSync(".github/workflows/probe.yml", "utf8"));
const page = workflow.jobs.probe.steps.find(step => step.id === "page");
const commands = `
GITHUB_OUTPUT=$(mktemp)
trap 'rm -f "$GITHUB_OUTPUT"' EXIT
date() { echo "\${MINUTE:-30}"; }
gh() {
  local runs=$RUNS limit=20 fields query=.
  while (( $# )); do
    case "$1" in
      --status) runs='[]'; shift ;;
      --limit) limit=$2; shift ;;
      --json) fields=$2; shift ;;
      --jq) query=$2; shift ;;
    esac
    shift
  done
  jq -r ".[:$limit] | map({$fields}) | $query" <<< "$runs"
}
`;

test("outside the hourly reminder, the newest completed probe determines whether to page", () => {
  const active = { status: "in_progress", conclusion: "" };
  const failed = { status: "completed", conclusion: "failure" };
  const healthy = { status: "completed", conclusion: "success" };
  for (const [runs, expected] of [
    [[active, failed, healthy], ""],
    [[active, healthy, failed], "page=true"],
    [[active], "page=true"],
  ] as const) {
    const output = execFileSync("bash", ["-eo", "pipefail", "-c", commands + page.run + '\ncat "$GITHUB_OUTPUT"'], {
      env: { ...process.env, GITHUB_REPOSITORY: "sample/console", RUNS: JSON.stringify(runs) },
      encoding: "utf8",
    });
    expect(output.trim()).toBe(expected);
  }
});

test("the hourly continuing-outage reminder accepts zero-padded minutes", () => {
  for (const [minute, expected] of [["00", "page=true"], ["08", "page=true"], ["09", "page=true"], ["10", ""]]) {
    const output = execFileSync("bash", ["-eo", "pipefail", "-c", commands + page.run + '\ncat "$GITHUB_OUTPUT"'], {
      env: { ...process.env, GITHUB_REPOSITORY: "sample/console", RUNS: '[{"status":"completed","conclusion":"failure"}]', MINUTE: minute },
      encoding: "utf8",
    });
    expect(output.trim(), minute).toBe(expected);
  }
});

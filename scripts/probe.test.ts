// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { expect, test } from "vitest";

const workflow = load(readFileSync(".github/workflows/probe.yml", "utf8"));
const page = workflow.jobs.notify.steps.find(step => step.id === "page");
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

const getEntry = workflow.jobs.probe.steps.find(step => step.env?.URL).run;
const fakeCurl = `
curl() {
  local out="" format="" url="" body="" meta=""
  while (( $# )); do
    case "$1" in
      -o|--output) out="$2"; shift 2 ;;
      -w|--write-out) format="$2"; shift 2 ;;
      https://*) url="$1"; shift ;;
      *) shift ;;
    esac
  done
  case "$url" in
    https://probe.test/) body="$HTML"; meta="$PAGE_TYPE" ;;
    https://probe.test/assets/app.js) body="$JS"; meta="$JS_TYPE" ;;
    *) return 22 ;;
  esac
  if [[ -n "$out" ]]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi
  if [[ -n "$format" ]]; then printf '%s' "$meta"; fi
}
`;
const healthy = {
  URL: "https://probe.test",
  HTML: '<script type="module" src="/assets/app.js"></script>',
  PAGE_TYPE: "200 text/html; charset=UTF-8", JS_TYPE: "200 text/javascript; charset=utf-8",
  JS: "export const ready = true;",
};

test.each([
  ["served module", {}, true],
  ["attribute order", { HTML: "<script src='/assets/app.js' crossorigin type='module'></script>" }, true],
  ["second missing module", { HTML: healthy.HTML + '<script type="module" src="/assets/missing.js"></script>' }, false],
  ["ordinary script alone", { HTML: '<script src="/assets/app.js"></script>' }, false],
  ["HTML fallback", { JS: "<!doctype html>", JS_TYPE: "200 text/html" }, false],
  ["HTML with JavaScript MIME", { JS: "<!doctype html>" }, false],
  ["empty script", { JS: "" }, false],
  ["redirect", { JS_TYPE: "302 text/javascript" }, false],
  ["redirected root", { PAGE_TYPE: "302 text/html" }, false],
] as const)("checks the returned page and module content for %s", (_, overrides, pass) => {
  const result = spawnSync("bash", ["-eo", "pipefail", "-c", fakeCurl + getEntry], {
    env: { ...process.env, ...healthy, ...overrides }, encoding: "utf8",
  });
  expect(result.status === 0, result.stderr).toBe(pass);
});

test("notification can run when the entire probe times out before producing outputs", () => {
  const notify = workflow.jobs.notify;
  expect(notify.needs).toBe("probe");
  expect(notify.if).toBe("failure() && needs.probe.result == 'failure'");
  expect(notify.steps.find(step => step.env?.ONS_TOPIC_ID).if).toBe("steps.page.outputs.page == 'true'");
});

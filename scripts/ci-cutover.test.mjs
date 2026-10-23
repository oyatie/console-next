// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("GitOps cutover keeps script CD deleted and workflow checks execute the CI contract", () => {
  for (const file of [".github/workflows/cd.yml", "scripts/cd-workflow.test.mjs"]) assert.equal(existsSync(new URL(`../${file}`, import.meta.url)), false);
  for (const file of [".github/workflows/ci.yml", ".github/workflows/workflows-check.yml", "package.json"]) assert.doesNotMatch(read(file), /cd-workflow|cd\.yml/);
  const wf = load(read(".github/workflows/workflows-check.yml"));
  for (const event of ["pull_request", "push"]) assert.ok(wf.on[event].paths.includes("scripts/ci*.mjs"));
  assert.ok(wf.jobs.workflows.steps.some((s) => s.run?.includes("node --test scripts/ci.test.mjs")));
  assert.ok(JSON.parse(read("package.json")).scripts.check.includes("scripts/e2e-support-logs.test.mjs"));
});

test("probe stays opt-in and sends failures only through the shared Telegram adapter", () => {
  const wf = load(read(".github/workflows/probe.yml"));
  assert.equal(wf.jobs.probe.if, "vars.PROBE_ENABLED == 'true'");
  assert.doesNotMatch(read(".github/workflows/probe.yml"), /OCI_|ONS_|ons message|oracle\/oci/);
  const notice = wf.jobs.notify.steps.find((s) => s.run?.includes("notify-telegram.sh send"));
  assert.equal(notice.env.CONSOLE_TELEGRAM_BOT_TOKEN, "${{ secrets.CONSOLE_TELEGRAM_BOT_TOKEN }}");
  assert.equal(notice.env.CONSOLE_TELEGRAM_CHAT_ID, "${{ secrets.CONSOLE_TELEGRAM_CHAT_ID }}");
  assert.match(wf.jobs.notify.if, /needs.probe.outputs.page == 'true'/);
});

test("release-unit dispatch selects the long tier; PR and queue retain affected fast proof", async () => {
  const { tierPlan } = await import("./ci/plan.mjs");
  const config = JSON.parse(read("scripts/ci/config.json"));
  const packages = [
    { name: "leaf", manifest_path: "/repo/backend/leaf/Cargo.toml", dependencies: [] },
    { name: "other", manifest_path: "/repo/backend/other/Cargo.toml", dependencies: [] },
  ];
  for (const event of ["pull_request", "merge_group", "push"]) {
    const p = tierPlan(event, ["backend/leaf/src/lib.rs"], packages, [], "/repo", config);
    assert.equal(p.tier, "fast");
    assert.equal(p.full, false);
    assert.deepEqual(p.crates, ["leaf"]);
    assert.equal(p.e2e, false);
  }
  const release = tierPlan("workflow_dispatch", [], packages, [], "/repo", config);
  assert.equal(release.tier, "release");
  assert.equal(release.full, true);
  assert.deepEqual(release.crates, ["leaf", "other"]);
  assert.equal(release.e2e, true);
  assert.equal(release.e2eFiles, null);
  assert.deepEqual(release.browsers, ["chromium", "firefox"]);
  assert.ok(Object.hasOwn(load(read(".github/workflows/ci.yml")).on, "workflow_dispatch"));
});

test("fast browser proof covers configured smoke and changed specs without changing shard format", async () => {
  const { tierPlan } = await import("./ci/plan.mjs");
  const config = JSON.parse(read("scripts/ci/config.json"));
  const p = tierPlan("merge_group", ["e2e/person.spec.ts", "e2e/helpers/people.ts"], [], [], "/repo", config);
  assert.deepEqual(p.e2eFiles, [...new Set([...config.fastE2eFiles, "person.spec.ts"])].sort());
  assert.deepEqual(p.browsers, ["chromium"]);
  assert.ok(config.fastE2eFiles.includes("first-run-solo.spec.ts"));
  const wf = load(read(".github/workflows/ci.yml"));
  assert.equal(wf.jobs.plan.outputs.e2eFiles, "${{ steps.plan.outputs.e2eFiles }}");
  assert.equal(wf.jobs.plan.outputs.browsers, "${{ steps.plan.outputs.browsers }}");
  assert.match(wf.jobs["e2e-plan"].steps.find((s) => s.run === "node scripts/ci/e2e.mjs plan").env.CI_PLAN, /toJSON\(needs.plan.outputs\)/);
});

test("fast shard CLI selects Chromium smoke and changed specs with the shared matrix contract", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-fast-shards-"));
  try {
    const config = JSON.parse(read("scripts/ci/config.json"));
    const files = [...new Set([...config.fastE2eFiles, "life.spec.ts"])].sort();
    const output = path.join(dir, "outputs");
    const result = spawnSync(process.execPath, ["scripts/ci/e2e.mjs", "plan"], {
      encoding: "utf8", env: { ...process.env, E2E_SERVED: "1", E2E_TIMINGS_FILE: path.join(dir, "timings.json"), GITHUB_OUTPUT: output,
        CI_PLAN: JSON.stringify({ e2e: "true", browsers: JSON.stringify(config.fastBrowsers), e2eFiles: JSON.stringify(files) }) },
    });
    assert.equal(result.status, 0, result.stderr);
    const matrix = JSON.parse(readFileSync(output, "utf8").split("\n").find((line) => line.startsWith("matrix=")).slice(7));
    assert.deepEqual(matrix.include.flatMap((job) => job.files).sort(), files);
    assert.ok(matrix.include[0].files.includes("first-run-solo.spec.ts"));
    for (const job of matrix.include) {
      assert.deepEqual(Object.keys(job).sort(), ["browser", "est", "files", "project", "shard"]);
      assert.equal(job.browser, "chromium");
      assert.ok(job.shard > 0 && job.est > 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("browser-backed unit checks install Chromium and use the planner base", () => {
  const steps = load(read(".github/workflows/ci.yml")).jobs.web.steps;
  const check = steps.findIndex((step) => step.run === "npm run check");
  assert.ok(check > 0);
  assert.ok(steps.slice(0, check).some((step) => step.run === "npx playwright install --with-deps --only-shell chromium"));
  assert.equal(steps[check].env?.CI_BASE_SHA, "${{ needs.plan.outputs.base }}");
});

test("ruleset cutover updates dev-pr-only and documents removal of the dead push ruleset", () => {
  assert.equal(JSON.parse(read(".github/rulesets/dev.json")).name, "dev-pr-only");
  assert.match(read("docs/ci.md"), /gh api --method PUT "repos\/\$repo\/rulesets\/25624651" --input \.github\/rulesets\/dev\.json/);
  assert.match(read("docs/ci.md"), /gh api --method DELETE "repos\/\$repo\/rulesets\/25552233"/);
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";
import { planBudget } from "./ci/plan.mjs";
import { plan } from "./e2e-timings.mjs";

const config = JSON.parse(readFileSync(new URL("./ci/config.json", import.meta.url), "utf8"));
const workflow = load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")).jobs;
const selection = { backend: true, web: true, e2e: true, unit: true, db: true };
const overhead = planBudget(selection, config, []).jobs;

function syntheticPlan({ multiplier = 1, counts = [8, 8], maxJobs = overhead + 16 } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-synthetic-shards-"));
  try {
    for (const sub of ["scripts/ci", "node_modules/.bin"]) mkdirSync(path.join(dir, sub), { recursive: true });
    writeFileSync(path.join(dir, "scripts/ci/config.json"), JSON.stringify({ ...config, e2eReservedShards: 4, maxJobs }));
    writeFileSync(path.join(dir, config.quarantineFile), "[]");
    copyFileSync(new URL("./ci/test-results.py", import.meta.url), path.join(dir, "scripts/ci/test-results.py"));
    const seed = { _license: "SPDX-License-Identifier: LicenseRef-Proprietary" };
    const inventories = config.releaseBrowsers.map((browser, i) => ({ suites: Array.from({ length: counts[i] }, (_, n) => {
      const file = n === 0 ? "first-run-solo.spec.ts" : `synthetic-${n}.spec.ts`;
      const project = browser === "firefox" ? "firefox" : "parallel";
      seed[`served:${project} › ${file} › synthetic`] = { s: 1000 * multiplier, at: 0 };
      return { file, specs: [{ title: "synthetic", tests: [{ projectName: project, expectedStatus: "passed" }] }] };
    }) }));
    writeFileSync(path.join(dir, config.e2eTimingsSeed), JSON.stringify(seed));
    writeFileSync(path.join(dir, "node_modules/.bin/playwright"), `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(${JSON.stringify(inventories)}[process.env.E2E_XBROWSER==='1'?1:0]));\n`, { mode: 0o700 });
    const output = path.join(dir, "outputs");
    const result = spawnSync(process.execPath, [new URL("./ci/e2e.mjs", import.meta.url).pathname, "plan"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, CI_PLAN: "", E2E_SERVED: "1", E2E_TIMINGS_FILE: path.join(dir, "unused.json"), GITHUB_OUTPUT: output },
    });
    if (result.status !== 0) return { result };
    const values = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), JSON.parse(line.slice(line.indexOf("=") + 1))]));
    return { result, jobs: values.matrix.include, budget: values.budget };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("served synthetic seed scales from 8 to 16 shards when durations or the suite double", () => {
  for (const [multiplier, files, expected] of [[1, 8, 8], [2, 8, 16], [1, 16, 16]]) {
    const { result, jobs, budget } = syntheticPlan({ multiplier, counts: [files, files] });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(jobs.length, expected);
    assert.equal(budget.jobs, overhead + jobs.length);
    assert.match(result.stdout, /Predicted per-job minutes/);
    for (const browser of config.releaseBrowsers) {
      const shards = jobs.filter((job) => job.browser === browser);
      assert.equal(shards.length, expected / 2);
      assert.ok(shards[0].files.includes("first-run-solo.spec.ts"));
      assert.equal(shards.flatMap((job) => job.files).length, files);
      assert.equal(new Set(shards.flatMap((job) => job.files)).size, files);
    }
    for (const job of jobs) assert.ok(config.jobMinutes.e2eSetup + job.est / 60 < workflow.e2e["timeout-minutes"] * 0.8);
  }
});

test("browser shards share the whole job budget instead of reserving half per browser", () => {
  const { result, jobs } = syntheticPlan({ multiplier: 2, counts: [14, 2] });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(jobs.filter((job) => job.browser === "chromium").length, 14);
  assert.equal(jobs.filter((job) => job.browser === "firefox").length, 2);
});

test("duration growth reports a budget error only after exhausting all available jobs", () => {
  const { result } = syntheticPlan({ multiplier: 2, maxJobs: overhead + 15 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`job budget: ${overhead + 16} jobs required, ${overhead + 15} configured`));
  assert.doesNotMatch(result.stderr, /timeout headroom/);
});

test("bounded bins preserve serial projects and refuse a file that cannot fit alone", () => {
  const tests = Array.from({ length: 3 }, (_, i) => ({ project: "clock", file: `${i}.spec.ts`, key: String(i) }));
  const timings = Object.fromEntries(tests.map((test) => [test.key, { s: 60 }]));
  const jobs = plan(tests, timings, { target: 1000, maxSeconds: 160, workers: 4 });
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs.map((job) => job.est), [160, 100]);
  assert.equal(jobs.flatMap((job) => job.files).length, 3);
  assert.ok(jobs.every((job) => job.est <= 160));
  assert.throws(() => plan(tests, timings, { maxSeconds: 99 }), /file exceeds timeout headroom: 0\.spec\.ts/);
});

test("planner Cargo metadata is offline and bounds stalled Cargo or rustup downloads", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "console-metadata-deadline-"));
  try {
    mkdirSync(path.join(dir, "scripts/ci"), { recursive: true });
    writeFileSync(path.join(dir, "scripts/ci/config.json"), JSON.stringify({ ...config, jobMinutes: { ...config.jobMinutes, plan: 0.01 } }));
    writeFileSync(path.join(dir, "event.json"), JSON.stringify({ before: "synthetic-base" }));
    writeFileSync(path.join(dir, "git"), `#!${process.execPath}\nprocess.stdout.write(process.argv[2]==='rev-parse'?'synthetic-base':'docs/ci.md\\0');\n`, { mode: 0o700 });
    writeFileSync(path.join(dir, "cargo"), `#!${process.execPath}\nif(!process.argv.includes('--offline'))process.exit(97);require('node:fs').writeFileSync(process.env.METADATA_RECEIPT,'offline');setTimeout(()=>{},30000);\n`, { mode: 0o700 });
    const result = spawnSync(process.execPath, [new URL("./ci/plan.mjs", import.meta.url).pathname], {
      cwd: dir, encoding: "utf8", timeout: 5000,
      env: { ...process.env, CI_BASE_SHA: "synthetic-base", PATH: `${dir}:${process.env.PATH}`, GITHUB_EVENT_PATH: path.join(dir, "event.json"), METADATA_RECEIPT: path.join(dir, "receipt") },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(path.join(dir, "receipt"), "utf8"), "offline");
    assert.match(result.stderr, /ETIMEDOUT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

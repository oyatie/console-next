// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const settings = { budgetSeconds: 300, startupSeconds: 40, workers: 2, defaultTestSeconds: 10, specs: {} };
const report = (counts, seconds = 4) => ({
  errors: [],
  suites: Object.entries(counts).map(([file, count]) => ({ file, specs: Array.from({ length: count }, (_, i) => ({
    title: `case ${i}`, tests: [{ projectName: "", expectedStatus: "passed", results: [{ status: "passed", duration: seconds * 1000 }] }],
  })) })),
});
const load = () => import("./states-shards.mjs");
const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test("greedy duration packing balances the fixture within 15% and covers every spec exactly once", async () => {
  const { planStates } = await load();
  const specs = Object.fromEntries([120, 110, 100, 90, 80, 70, 60, 50].map((seconds, i) => [`mock/${i}.spec.ts`, { seconds, tests: 1 }]));
  const plan = planStates(report(Object.fromEntries(Object.keys(specs).map(file => [file, 1]))), { ...settings, specs });
  assert.equal(plan.shards.length, 3);
  const average = plan.shards.reduce((sum, s) => sum + s.seconds, 0) / plan.shards.length;
  assert.ok(plan.shards.every(s => Math.abs(s.seconds - average) / average <= 0.15));
  assert.ok(plan.shards.every(s => s.seconds <= settings.budgetSeconds));
  assert.deepEqual(plan.shards.flatMap(s => s.files).sort(), Object.keys(specs).map(f => `e2e/${f}`).sort());
});

test("new specs and new cases in a measured spec receive the conservative default", async () => {
  const { planStates } = await load();
  const timings = { ...settings, specs: { "mock/known.spec.ts": { seconds: 20, tests: 2 } } };
  const plan = planStates(report({ "mock/known.spec.ts": 4, "states/new.spec.ts": 4 }), timings);
  assert.equal(plan.shards[0].seconds, settings.startupSeconds + 20 + 2 * 5 + 4 * 5);
  assert.equal(plan.shards.length, 1);
});

test("packing adds capacity when ceil(total / budget) still overfills a bin", async () => {
  const { planStates } = await load();
  const specs = Object.fromEntries([0, 1, 2].map(i => [`mock/${i}.spec.ts`, { seconds: 150, tests: 1 }]));
  const plan = planStates(report(Object.fromEntries(Object.keys(specs).map(f => [f, 1]))), { ...settings, specs });
  assert.equal(plan.shards.length, 3);
  assert.ok(plan.shards.every(s => s.seconds <= settings.budgetSeconds));
});

test("an over-budget spec fails planning with its name before a runner starts", async () => {
  const { planStates } = await load();
  assert.throws(() => planStates(report({ "states/too-long.spec.ts": 1 }), {
    ...settings, specs: { "states/too-long.spec.ts": { seconds: 261, tests: 1 } },
  }), /STATES_SPEC_OVER_BUDGET.*states\/too-long\.spec\.ts.*301.*300/);
});

test("a plan beyond GitHub's matrix limit fails planning explicitly", async () => {
  const { planStates } = await load();
  const specs = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`mock/${i}.spec.ts`, { seconds: 260, tests: 1 }]));
  assert.throws(() => planStates(report(Object.fromEntries(Object.keys(specs).map(f => [f, 1]))), { ...settings, specs }), /STATES_MATRIX_LIMIT/);
});

test("a matrix selects only planned shards; malformed and oversized plans fail closed", async () => {
  const { planStates, filesForShard } = await load();
  const plan = planStates(report({ "mock/a.spec.ts": 4 }), settings);
  assert.deepEqual(filesForShard(plan, 1), ["e2e/mock/a.spec.ts"]);
  for (const id of [0, 2, -1, 1.1, "1;echo bad"]) assert.throws(() => filesForShard(plan, id), /STATES_INVALID_SHARD/);
  assert.throws(() => filesForShard({ ...plan, shards: [{ ...plan.shards[0], seconds: 301 }] }, 1), /STATES_INVALID_PLAN/);
  assert.throws(() => filesForShard({ ...plan, shards: [...plan.shards, ...plan.shards] }, 1), /STATES_INVALID_PLAN/);
});

test("invalid timing inputs, an empty suite and discovery errors cannot create a green empty matrix", async () => {
  const { planStates } = await load();
  for (const patch of [{ workers: 0 }, { budgetSeconds: 40 }, { defaultTestSeconds: -1 }, { specs: { "mock/a.spec.ts": { seconds: NaN, tests: 1 } } }]) {
    assert.throws(() => planStates(report({ "mock/a.spec.ts": 1 }), { ...settings, ...patch }), /STATES_INVALID_TIMINGS/);
  }
  assert.throws(() => planStates(report({}), settings), /STATES_EMPTY_SUITE/);
  assert.throws(() => planStates({ ...report({ a: 1 }), errors: [{ message: "discovery failed" }] }, settings), /STATES_DISCOVERY_FAILED/);
});

test("complete JSON results refresh per-spec timings using the configured worker count", async () => {
  const { planStates, refreshTimings } = await load();
  const observed = report({ "mock/a.spec.ts": 4 });
  const plan = planStates(observed, settings);
  const refreshed = refreshTimings(settings, plan, [observed]);
  assert.deepEqual(refreshed.specs, { "mock/a.spec.ts": { seconds: 8, tests: 4 } });
  assert.equal(refreshed.budgetSeconds, undefined);
  assert.equal(refreshed.workers, settings.workers);
});

test("incomplete, failed, duplicate and unplanned results cannot poison trusted durations", async () => {
  const { planStates, refreshTimings } = await load();
  const observed = report({ "mock/a.spec.ts": 4 });
  const plan = planStates(observed, settings);
  const failed = report({ "mock/a.spec.ts": 4 });
  failed.suites[0].specs[0].tests[0].results[0].status = "failed";
  for (const results of [[], [report({ "mock/a.spec.ts": 3 })], [failed], [observed, observed], [report({ "mock/extra.spec.ts": 4 })]]) {
    assert.throws(() => refreshTimings(settings, plan, results), /STATES_INCOMPLETE_RESULTS/);
  }
});

test("refresh refuses report errors and worker mismatches even with complete passing results", async () => {
  const { planStates, refreshTimings } = await load();
  const observed = report({ "mock/a.spec.ts": 4 });
  const plan = planStates(observed, settings);
  for (const patch of [{ errors: [{ message: "worker crashed" }] }, { config: { workers: 1 } }, { config: { workers: 0 } }]) {
    assert.throws(() => refreshTimings(settings, plan, [{ ...observed, ...patch }]), /STATES_INCOMPLETE_RESULTS/);
  }
});

test("a repeated file is rejected even when shard IDs and budgets are valid", async () => {
  const { planStates, filesForShard, refreshTimings } = await load();
  const observed = report({ "mock/a.spec.ts": 1 });
  const plan = planStates(observed, settings);
  const repeated = { ...plan, shards: [plan.shards[0], { ...plan.shards[0], id: 2 }] };
  assert.throws(() => filesForShard(repeated, 1), /STATES_INVALID_PLAN.*repeated spec/);
  assert.throws(() => refreshTimings(settings, repeated, [observed]), /STATES_INVALID_PLAN.*repeated spec/);
});

test("CI uses committed settings, takes only compatible artifact durations, and refreshes without overwriting settings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "states-settings-"));
  const committed = { budgetSeconds: 60, startupSeconds: 5, workers: 4, defaultTestSeconds: 20,
    specs: { "mock/a.spec.ts": { seconds: 2, tests: 1 } } };
  const observed = { ...report({ "mock/a.spec.ts": 3, "states/new.spec.ts": 2 }), config: { workers: committed.workers } };
  try {
    for (const folder of ["bin", "scripts", "e2e/mock", ".cache/states-timings", ".cache/states-reports"]) mkdirSync(path.join(dir, folder), { recursive: true });
    for (const file of ["states-shards.mjs", "e2e-timings.mjs"]) writeFileSync(path.join(dir, "scripts", file), readFileSync(new URL(file, import.meta.url)));
    writeFileSync(path.join(dir, "bin/npx"), '#!/bin/sh\nprintf "%s" "$TEST_REPORT"\n', { mode: 0o755 });
    writeFileSync(path.join(dir, "bin/npm"), '#!/bin/sh\nprintf "%s" "$TEST_REPORT" > "$PLAYWRIGHT_JSON_OUTPUT_FILE"\n', { mode: 0o755 });
    const configFile = path.join(dir, "e2e/mock/timings.json");
    const original = JSON.stringify(committed);
    writeFileSync(configFile, original);
    const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, TEST_REPORT: JSON.stringify(observed),
      PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(dir, ".cache/states-reports/one.json") };
    const step = workflow.jobs["states-plan"].steps.find(s => s.id === "plan");
    const refresh = workflow.jobs["states-timings"].steps.find(s => s.run?.includes("states-shards.mjs refresh"));
    for (const workers of [committed.workers, 2]) {
      writeFileSync(path.join(dir, ".cache/states-timings/timings.json"), JSON.stringify({
        budgetSeconds: 900, startupSeconds: 80, defaultTestSeconds: 1000, workers,
        specs: { "mock/a.spec.ts": { seconds: 9, tests: 1 } },
      }));
      const planned = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], { cwd: dir, env, encoding: "utf8" });
      assert.equal(planned.status, 0, planned.stderr);
      const plan = JSON.parse(readFileSync(path.join(dir, ".cache/states-plan/plan.json"), "utf8"));
      assert.equal(plan.budgetSeconds, committed.budgetSeconds);
      assert.equal(plan.shards[0].seconds, workers === committed.workers ? 34 : 27);
      const ran = spawnSync(process.execPath, ["scripts/states-shards.mjs", "run", ".cache/states-plan/plan.json", "1"], { cwd: dir, env, encoding: "utf8" });
      assert.equal(ran.status, 0, ran.stderr);
      const refreshed = spawnSync("bash", ["-e", "-o", "pipefail", "-c", refresh.run], { cwd: dir, env, encoding: "utf8" });
      assert.equal(refreshed.status, 0, refreshed.stderr);
      assert.equal(readFileSync(configFile, "utf8"), original);
      const upload = workflow.jobs["states-timings"].steps.find(s => s.with?.name === "states-timings");
      const measured = JSON.parse(readFileSync(path.join(dir, upload.with.path), "utf8"));
      assert.equal(measured.workers, committed.workers);
      assert.deepEqual(measured.specs["mock/a.spec.ts"], { seconds: 3, tests: 3 });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CLI emits exactly its dynamic matrix and rejects a shard outside it before npm executes", async () => {
  await load();
  const dir = mkdtempSync(path.join(tmpdir(), "states-plan-"));
  try {
    const listing = path.join(dir, "list.json"), timing = path.join(dir, "timing.json"), plan = path.join(dir, "plan.json"), output = path.join(dir, "output");
    writeFileSync(listing, JSON.stringify(report({ "mock/a.spec.ts": 2 })));
    writeFileSync(timing, JSON.stringify(settings));
    const result = spawnSync(process.execPath, ["scripts/states-shards.mjs", "plan", listing, timing, plan], { encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
    assert.equal(result.status, 0, result.stderr);
    const planned = JSON.parse(readFileSync(plan, "utf8"));
    assert.equal(readFileSync(output, "utf8"), `matrix=${JSON.stringify({ shard: planned.shards.map(s => s.id) })}\n`);
    const bad = spawnSync(process.execPath, ["scripts/states-shards.mjs", "run", plan, "2"], { encoding: "utf8" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /STATES_INVALID_SHARD/);
    const unknown = spawnSync(process.execPath, ["scripts/states-shards.mjs", "typo"], { encoding: "utf8" });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /STATES_INVALID_COMMAND/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the actual Chromium config discovers the suite and Playwright selects exactly the supplied file list", () => {
  const list = extra => {
    const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config=e2e/mock/playwright.config.ts", "--list", "--reporter=json", ...extra], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const files = list([]).suites.slice(0, 2).map(s => s.file);
  assert.equal(files.length, 2);
  const dir = mkdtempSync(path.join(tmpdir(), "states-selection-"));
  try {
    const file = path.join(dir, "selection.txt");
    writeFileSync(file, files.join("\n"));
    assert.deepEqual(list([`--test-list=${file}`]).suites.map(s => s.file).sort(), [...files].sort());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a successful Playwright exit with an empty selection cannot pass a shard", async () => {
  const { planStates } = await load();
  const dir = mkdtempSync(path.join(tmpdir(), "states-empty-"));
  try {
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin/npm"), '#!/bin/sh\nprintf \'{"suites":[],"errors":[]}\' > "$PLAYWRIGHT_JSON_OUTPUT_FILE"\n', { mode: 0o755 });
    const planFile = path.join(dir, "plan.json");
    writeFileSync(planFile, JSON.stringify(planStates(report({ "mock/a.spec.ts": 1 }), settings)));
    mkdirSync(path.join(dir, "e2e/mock"), { recursive: true });
    writeFileSync(path.join(dir, "e2e/mock/timings.json"), JSON.stringify(settings));
    const result = spawnSync(process.execPath, [path.resolve("scripts/states-shards.mjs"), "run", planFile, "1"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(dir, "report.json") },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /STATES_INCOMPLETE_RESULTS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ci-ok fails when the planner or any matrix shard fails or is skipped", () => {
  const aggregate = workflow.jobs["ci-ok"].steps[0].run;
  const run = (plan, states, refresh = "skipped") => spawnSync("bash", ["-e", "-c", aggregate.replace(/\$\{\{ needs(?:\.([\w-]+)|\['([\w-]+)'\])\.result \}\}/g, (_, dotted, quoted) => {
    const name = dotted ?? quoted;
    return name === "states-plan" ? plan : name === "states" ? states : name === "states-timings" ? refresh : "success";
  })], { encoding: "utf8" });
  assert.equal(run("success", "success").status, 0);
  assert.equal(run("success", "success", "success").status, 0);
  for (const result of ["failure", "skipped", "cancelled"]) {
    assert.notEqual(run(result, "success").status, 0);
    assert.notEqual(run("success", result).status, 0);
  }
  assert.notEqual(run("success", "success", "failure").status, 0);
});

test("CI restores only unexpired dev timings from this repository, never PRs or forks", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "states-timings-"));
  try {
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin/curl"), '#!/bin/sh\nprintf "%s" "$ARTIFACTS"\n', { mode: 0o755 });
    const step = workflow.jobs["states-plan"]?.steps.find(s => s.id === "timings");
    assert.ok(step);
    const artifact = (id, run = {}, extra = {}) => ({ expired: false, workflow_run: { id, head_branch: "dev", repository_id: 1, head_repository_id: 1, ...run }, ...extra });
    for (const artifacts of [[], [artifact(1, {}, { expired: true })], [artifact(2, { head_branch: "feature" })], [artifact(3, { head_repository_id: 9 })], [artifact(4, { head_repository_id: undefined, repository_id: undefined })], [artifact(5)]]) {
      const output = path.join(dir, "output");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], { encoding: "utf8", env: {
        ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, RUNNER_TEMP: dir,
        GITHUB_OUTPUT: output, GITHUB_REPOSITORY_ID: "1", ARTIFACTS: JSON.stringify({ artifacts }),
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), artifacts[0]?.workflow_run.id === 5 ? "run-id=5\n" : "");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("CI consumes the plan's matrix and exact file list and ci-ok requires planning and all shards", () => {
  const jobs = workflow.jobs;
  assert.equal(jobs.states.needs, "states-plan");
  assert.match(jobs.states.strategy.matrix, /fromJSON\(needs\['states-plan'\].outputs.matrix\)/);
  assert.equal(jobs.states.strategy["fail-fast"], false);
  const run = jobs.states.steps.find(s => s.run?.includes("scripts/states-shards.mjs run"));
  assert.ok(run);
  assert.match(run.run, /matrix\.shard/);
  assert.ok(jobs["ci-ok"].needs.includes("states-plan"));
  assert.ok(jobs["ci-ok"].needs.includes("states"));
  assert.match(jobs["ci-ok"].steps[0].run, /needs\['states-plan'\]\.result/);
  assert.match(jobs["ci-ok"].steps[0].run, /needs\.states\.result/);
  assert.match(jobs["states-timings"].if, /github\.event_name == 'push'/);
  assert.match(jobs["states-timings"].if, /refs\/heads\/dev/);
  assert.match(readFileSync(new URL("../package.json", import.meta.url), "utf8"), /--global-timeout=600000/);
});

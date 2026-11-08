// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { RUN_HEADROOM } from "./states-shards.mjs";

const settings = { setupAllowanceSeconds: 120, budgetSeconds: 300, startupSeconds: 40, workers: 2, defaultTestSeconds: 10, specs: {} };
const report = (counts, seconds = 4) => ({
  errors: [],
  suites: Object.entries(counts).map(([file, count]) => ({ file, specs: Array.from({ length: count }, (_, i) => ({
    title: `case ${i}`, tests: [{ projectName: "", expectedStatus: "passed", results: [{ status: "passed", duration: seconds * 1000 }] }],
  })) })),
});
const load = () => import("./states-shards.mjs");
const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test("the module route inventory includes app floorplan declarations", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "module-routes-"));
  try {
    const output = path.join(dir, "modules.json");
    const result = spawnSync(process.execPath, ["scripts/d8-module-routes.mjs", output], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const inventory = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(inventory.floorplans["/account"], "P-05");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the module route inventory refuses an unknown floorplan", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "module-routes-unknown-"));
  try {
    mkdirSync(path.join(dir, "apps/web"), { recursive: true });
    cpSync("apps/web/src", path.join(dir, "apps/web/src"), { recursive: true });
    symlinkSync(path.resolve("node_modules"), path.join(dir, "node_modules"), "dir");
    const app = path.join(dir, "apps/web/src/routes/app.ts");
    const source = readFileSync(app, "utf8");
    const planted = source.replace(
      /path: "\/account", staticData: \{[^}]+\}/,
      'path: "/account", staticData: { access: "signed-in", floorplan: "P-06" }',
    );
    assert.notEqual(planted, source, "account route plant was not applied");
    writeFileSync(app, planted);
    const result = spawnSync(process.execPath, [path.resolve("scripts/d8-module-routes.mjs"), path.join(dir, "modules.json")], { cwd: dir, encoding: "utf8" });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /app route floorplans are unreadable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

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

test("new specs and new cases use measured per-test P95 above the default floor", async () => {
  const { planStates } = await load();
  const timings = { ...settings, specs: { "mock/known.spec.ts": { seconds: 20, tests: 2 } } };
  const plan = planStates(report({ "mock/known.spec.ts": 4, "states/new.spec.ts": 4 }), timings);
  assert.equal(plan.shards[0].seconds, settings.startupSeconds + 20 + 2 * 10 + 4 * 10);
  assert.equal(plan.shards.length, 1);
  const fallback = planStates(report({ "states/new.spec.ts": 4 }), settings);
  assert.equal(fallback.shards[0].seconds, settings.startupSeconds + 4 * settings.defaultTestSeconds / settings.workers);
});

test("an unknown 30-test spec uses nearest-rank P95 and adds a shard with headroom", async () => {
  const { planStates } = await load();
  const specs = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`mock/${i}.spec.ts`, { seconds: (i + 1) ** 2, tests: i + 1 }]));
  const timings = { ...settings, specs, budgetSeconds: 600, timeoutSeconds: 1200, maxShards: 5 };
  const plan = planStates(report({ "mock/19.spec.ts": 20, "states/new.spec.ts": 30 }), timings);
  assert.equal(plan.shards.length, 2);
  assert.equal(plan.shards.find(s => s.files.includes("e2e/states/new.spec.ts")).seconds, settings.startupSeconds + 30 * 19);
  assert.ok(plan.shards.every(s => s.seconds * RUN_HEADROOM <= timings.timeoutSeconds));
  assert.equal(plan.testCounts["states/new.spec.ts"], 30);
});

test("unknown estimates that exceed whole-spec or shard capacity request timings", async () => {
  const { planStates } = await load();
  // The run limit leaves a 480 s execution timeout after headroom.
  const timings = { ...settings, timeoutSeconds: 600, runLimitSeconds: 480 * RUN_HEADROOM, maxShards: 1,
    specs: { "mock/known.spec.ts": { seconds: 20, tests: 1 } } };
  assert.throws(() => planStates(report({ "states/new.spec.ts": 30 }), timings), /STATES_SPEC_OVER_BUDGET.*states\/new\.spec\.ts.*add timings/i);
  assert.throws(() => planStates(report({ "mock/known.spec.ts": 1, "states/new.spec.ts": 22 }), timings), /STATES_TIMEOUT_LIMIT.*add timings.*states\/new\.spec\.ts/i);
});

test("packing adds shards before consuming the RUN_HEADROOM run headroom", async () => {
  const { planStates } = await load();
  const specs = Object.fromEntries([0, 1, 2].map(i => [`mock/${i}.spec.ts`, { seconds: 500, tests: 1 }]));
  const input = report(Object.fromEntries(Object.keys(specs).map(file => [file, 1])));
  const timings = { ...settings, specs, timeoutSeconds: 1080, runLimitSeconds: 1080, maxShards: 3 };
  const plan = planStates(input, timings);
  assert.equal(plan.shards.length, 3);
  assert.ok(plan.budgetSeconds * RUN_HEADROOM <= timings.timeoutSeconds);
  assert.throws(() => planStates(input, { ...timings, maxShards: 2 }), /STATES_TIMEOUT_LIMIT/);
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

test("a plan beyond the timeout at GitHub's matrix limit fails planning explicitly", async () => {
  const { planStates } = await load();
  const specs = Object.fromEntries(Array.from({ length: 257 }, (_, i) => [`mock/${i}.spec.ts`, { seconds: 260, tests: 1 }]));
  assert.throws(() => planStates(report(Object.fromEntries(Object.keys(specs).map(f => [f, 1]))), { ...settings, specs }), /STATES_TIMEOUT_LIMIT/);
});

test("the shard ceiling stretches the budget through whole-file packing without dropping specs", async () => {
  const { planStates, filesForShard } = await load();
  const specs = Object.fromEntries([0, 1, 2].map(i => [`mock/${i}.spec.ts`, { seconds: 150, tests: 1 }]));
  const input = report(Object.fromEntries(Object.keys(specs).map(f => [f, 1])));
  const plan = planStates(input, { ...settings, specs, maxShards: 2, timeoutSeconds: 600 });
  assert.equal(plan.shards.length, 2);
  assert.equal(plan.budgetSeconds, 340);
  assert.deepEqual(plan.shards.flatMap(s => filesForShard(plan, s.id)).sort(), Object.keys(specs).map(f => `e2e/${f}`).sort());
  for (const maxShards of [0, -1, 1.5, "4", 257]) {
    assert.throws(() => planStates(input, { ...settings, specs, maxShards }), /STATES_INVALID_TIMINGS/);
  }
});

test("the real suite allows 30 added tests and ten percent timing drift within the runner cap", async () => {
  const { planStates, filesForShard } = await load();
  const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config=e2e/mock/playwright.config.ts", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const discovered = JSON.parse(result.stdout);
  const timings = JSON.parse(readFileSync(new URL("../e2e/mock/timings.json", import.meta.url), "utf8"));
  const timeoutSeconds = timings.runLimitSeconds;
  assert.equal(timings.timeoutSeconds, 1080, "suite growth must fit without extending the planning limit");
  for (const drift of [1, 1.1]) {
    const input = { ...discovered, suites: [...discovered.suites, ...report({ "states/growth.spec.ts": 30 }).suites] };
    const measured = { workers: timings.workers, specs: Object.fromEntries(Object.entries(timings.specs).map(([file, entry]) => [file, { ...entry, seconds: entry.seconds * drift }])) };
    const plan = planStates(input, timings, measured);
    assert.ok(plan.shards.length <= timings.maxShards);
    assert.ok(plan.budgetSeconds > timings.budgetSeconds && plan.budgetSeconds <= timings.timeoutSeconds);
    assert.ok(plan.budgetSeconds * RUN_HEADROOM <= plan.runTimeoutMinutes * 60);
    assert.equal(plan.jobTimeoutMinutes, Math.ceil(timings.setupAllowanceSeconds / 60) + plan.runTimeoutMinutes);
    assert.deepEqual(plan.shards.flatMap(s => filesForShard(plan, s.id)).sort(), input.suites.map(s => `e2e/${s.file}`).sort());
  }
  assert.ok(timings.timeoutSeconds < timeoutSeconds - timings.startupSeconds);
});

test("planning refuses only when a spec or capped packing exceeds the execution timeout", async () => {
  const { planStates, filesForShard } = await load();
  const timings = { ...settings, maxShards: 2, timeoutSeconds: 1080 };
  const specs = Object.fromEntries([0, 1].map(i => [`mock/${i}.spec.ts`, { seconds: 1040, tests: 1 }]));
  const input = report(Object.fromEntries(Object.keys(specs).map(file => [file, 1])));
  const plan = planStates(input, { ...timings, specs });
  assert.equal(plan.budgetSeconds, timings.timeoutSeconds);
  for (const shard of plan.shards) filesForShard(plan, shard.id);
  assert.throws(() => planStates(report({ "mock/long.spec.ts": 1 }), { ...timings, specs: { "mock/long.spec.ts": { seconds: 1041, tests: 1 } } }), /STATES_SPEC_OVER_BUDGET.*1081.*1080/);
  specs["mock/2.spec.ts"] = { seconds: 1040, tests: 1 };
  assert.throws(() => planStates(report(Object.fromEntries(Object.keys(specs).map(file => [file, 1]))), { ...timings, specs }), /STATES_TIMEOUT_LIMIT: 2 shards cannot fit within 1080s/);
  for (const timeoutSeconds of [0, -1, "1080", NaN, 299]) {
    assert.throws(() => planStates(input, { ...timings, specs, timeoutSeconds }), /STATES_INVALID_TIMINGS/);
  }
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
  for (const patch of [{ workers: 0 }, { budgetSeconds: 40 }, { defaultTestSeconds: -1 }, { runLimitSeconds: 0 }, { runLimitSeconds: 299 }, { specs: { "mock/a.spec.ts": { seconds: NaN, tests: 1 } } }]) {
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

test("CI uses committed settings and stretched budgets, takes compatible durations, and preserves settings", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "states-settings-"));
  const committed = { setupAllowanceSeconds: 120, budgetSeconds: 60, timeoutSeconds: 600, maxShards: 1, startupSeconds: 5, workers: 4, defaultTestSeconds: 20,
    specs: { "mock/a.spec.ts": { seconds: 2, tests: 1 } } };
  const observed = { ...report({ "mock/a.spec.ts": 3, "states/new.spec.ts": 2 }), config: { workers: committed.workers } };
  try {
    for (const folder of ["bin", "scripts", "e2e/mock", ".cache/states-timings", ".cache/states-reports"]) mkdirSync(path.join(dir, folder), { recursive: true });
    for (const file of ["states-shards.mjs", "e2e-timings.mjs"]) writeFileSync(path.join(dir, "scripts", file), readFileSync(new URL(file, import.meta.url)));
    writeFileSync(path.join(dir, "bin/node"), `#!/bin/sh
if [ "$1" = "scripts/d8-module-routes.mjs" ]; then
  mkdir -p "$(dirname "$2")"
  printf '%s' '{"modules":[{"routes":["/login","/setup-passkey"]}]}' > "$2"
  exit 0
fi
exec "$REAL_NODE" "$@"
`, { mode: 0o755 });
    writeFileSync(path.join(dir, "bin/npx"), '#!/bin/sh\nprintf "%s" "$TEST_REPORT"\n', { mode: 0o755 });
    writeFileSync(path.join(dir, "bin/npm"), '#!/bin/sh\nprintf "%s" "$TEST_REPORT" > "$PLAYWRIGHT_JSON_OUTPUT_FILE"\n', { mode: 0o755 });
    const configFile = path.join(dir, "e2e/mock/timings.json");
    const original = JSON.stringify(committed);
    writeFileSync(configFile, original);
    const step = workflow.jobs["states-plan"].steps.find(s => s.id === "plan");
    const env = { ...process.env, ...step.env, REAL_NODE: process.execPath, PATH: `${dir}/bin:${process.env.PATH}`, TEST_REPORT: JSON.stringify(observed),
      PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(dir, ".cache/states-reports/one.json") };
    const refresh = workflow.jobs["states-timings"].steps.find(s => s.run?.includes("states-shards.mjs refresh"));
    for (const workers of [committed.workers, 2]) {
      writeFileSync(path.join(dir, ".cache/states-timings/timings.json"), JSON.stringify({
        budgetSeconds: 900, startupSeconds: 80, defaultTestSeconds: 1000, workers,
        specs: { "mock/a.spec.ts": { seconds: 65, tests: 1 } },
      }));
      const planned = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], { cwd: dir, env, encoding: "utf8" });
      assert.equal(planned.status, 0, planned.stderr);
      assert.deepEqual(JSON.parse(readFileSync(path.join(dir, step.env.E2E_MODULES_FILE), "utf8")), { modules: [{ routes: ["/login", "/setup-passkey"] }] });
      const plan = JSON.parse(readFileSync(path.join(dir, ".cache/states-plan/plan.json"), "utf8"));
      assert.equal(plan.budgetSeconds, workers === committed.workers ? 330 : committed.budgetSeconds);
      assert.equal(plan.shards[0].seconds, workers === committed.workers ? 330 : 27);
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

test("a shard gets a Playwright timeout derived from its plan with RUN_HEADROOM headroom", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "states-drift-"));
  const estimatedSeconds = 80;
  const timeoutSeconds = 120;
  const observed = { ...report({ "mock/a.spec.ts": 1 }, estimatedSeconds * RUN_HEADROOM), config: { workers: settings.workers } };
  const planned = { budgetSeconds: estimatedSeconds, testCounts: { "mock/a.spec.ts": 1 },
    shards: [{ id: 1, files: ["e2e/mock/a.spec.ts"], seconds: estimatedSeconds }] };
  try {
    for (const folder of ["bin", "scripts", "e2e/mock", ".cache"]) mkdirSync(path.join(dir, folder), { recursive: true });
    for (const file of ["states-shards.mjs", "e2e-timings.mjs"]) writeFileSync(path.join(dir, "scripts", file), readFileSync(new URL(file, import.meta.url)));
    writeFileSync(path.join(dir, "bin/npm"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS"\nprintf "%s" "$TEST_REPORT" > "$PLAYWRIGHT_JSON_OUTPUT_FILE"\n', { mode: 0o755 });
    writeFileSync(path.join(dir, "e2e/mock/timings.json"), JSON.stringify({ ...settings, budgetSeconds: estimatedSeconds, timeoutSeconds }));
    writeFileSync(path.join(dir, ".cache/plan.json"), JSON.stringify(planned));
    const env = { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, TEST_ARGS: path.join(dir, "args"), TEST_REPORT: JSON.stringify(observed) };
    const result = spawnSync(process.execPath, ["scripts/states-shards.mjs", "run", ".cache/plan.json", "1"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(env.TEST_ARGS, "utf8").trim().split("\n"), ["run", "e2e:states", "--", "--test-list=.cache/states-shard-1.txt", `--global-timeout=${Math.ceil(estimatedSeconds * RUN_HEADROOM) * 1000}`]);
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
    assert.equal(readFileSync(output, "utf8"), `matrix=${JSON.stringify({ include: planned.shards.map(s => ({ shard: s.id, runTimeoutMinutes: planned.runTimeoutMinutes, jobTimeoutMinutes: planned.jobTimeoutMinutes })) })}\n`);
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
  const discovered = list([]).suites;
  const selections = [discovered.slice(0, 2), ...discovered.filter(s => s.file.startsWith("states/attendance-")).map(s => [s])];
  assert.equal(selections[0].length, 2);
  const dir = mkdtempSync(path.join(tmpdir(), "states-selection-"));
  try {
    const file = path.join(dir, "selection.txt");
    for (const suites of selections) {
      writeFileSync(file, suites.map(s => s.file).join("\n"));
      assert.deepEqual(list([`--test-list=${file}`]).suites, suites);
    }
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
  const run = (plan, states, refresh = "skipped") => {
    const needs = Object.fromEntries(workflow.jobs["ci-ok"].needs.map(name => [name, { result: "success", outputs: { backend: "true", web: "true" } }]));
    for (const name of ["dev-artifacts", "backend-cache", "release-evidence"]) needs[name].result = "skipped";
    needs["states-plan"].result = plan;
    needs.states.result = states;
    needs["states-timings"].result = refresh;
    return spawnSync("bash", ["-e", "-c", aggregate], { encoding: "utf8", env: {
      ...process.env, NEEDS: JSON.stringify(needs), GITHUB_EVENT_NAME: "pull_request",
    } });
  };
  assert.equal(run("success", "success").status, 0);
  assert.notEqual(run("success", "success", "success").status, 0);
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
  assert.equal(run.env.E2E_MODULES_FILE, jobs["states-plan"].steps.find(s => s.id === "plan").env.E2E_MODULES_FILE);
  assert.ok(jobs["ci-ok"].needs.includes("states-plan"));
  assert.ok(jobs["ci-ok"].needs.includes("states"));
  assert.equal(jobs["ci-ok"].steps[0].env.NEEDS, "${{ toJSON(needs) }}");
  assert.match(jobs["states-timings"].if, /github\.event_name == 'push'/);
  assert.match(jobs["states-timings"].if, /needs.affected.outputs.web/);
  assert.match(readFileSync(new URL("../package.json", import.meta.url), "utf8"), /--global-timeout=600000/);
});


test("setup allowance is separate from the plan's run budget, including minute rounding", async () => {
  const { planStates } = await load();
  const plan = planStates(report({ "mock/a.spec.ts": 1 }), { ...settings, budgetSeconds: 301, setupAllowanceSeconds: 601 });
  assert.equal(plan.runTimeoutMinutes, Math.ceil(301 * RUN_HEADROOM / 60));
  assert.equal(plan.jobTimeoutMinutes, 11 + plan.runTimeoutMinutes);
  assert.ok(plan.runTimeoutMinutes * 60 >= plan.budgetSeconds * RUN_HEADROOM);
  for (const setupAllowanceSeconds of [undefined, 0, -1, "720", NaN]) {
    assert.throws(() => planStates(report({ "mock/a.spec.ts": 1 }), { ...settings, setupAllowanceSeconds }), /STATES_INVALID_TIMINGS/);
  }
});

test("CI gives state and web checks their full run budget after measured setup", () => {
  const states = workflow.jobs.states, web = workflow.jobs.web;
  assert.equal(states["timeout-minutes"], "${{ matrix.jobTimeoutMinutes }}");
  const run = states.steps.find(s => s.run?.includes("scripts/states-shards.mjs run"));
  assert.equal(run["timeout-minutes"], "${{ matrix.runTimeoutMinutes }}");
  const timings = JSON.parse(readFileSync(new URL("../e2e/mock/timings.json", import.meta.url), "utf8"));
  assert.equal(timings.setupAllowanceSeconds, (9 + 3) * 60);
  const check = web.steps.find(s => s.run?.includes("npm run check"));
  assert.equal(check["timeout-minutes"], 30);
  assert.deepEqual(check.run.trim().split("\n"), [
    "npm run check",
    "node --test scripts/ci-backend.test.mjs",
    "node --test scripts/ghcr-retention.test.mjs",
    "node --test scripts/negative-index.test.mjs",
    "python3 scripts/d7_evidence_test.py",
    "node --test scripts/d10-census.test.mjs",
    "python3 scripts/d10_evidence_test.py",
    "python3 scripts/d8_evidence_test.py",
    "python3 scripts/states_evidence_test.py",
    "CONSOLE_WEB_PORT=58743 npx playwright test --config apps/web/src/features/people/ui/grid-table.playwright.ts grid-table.spec.ts grid-table-focus.spec.ts grid-table-paste.spec.ts",
  ]);
  assert.equal(web["timeout-minutes"], Math.ceil(timings.setupAllowanceSeconds / 60) + check["timeout-minutes"]);
});

test("both jobs cache Chromium by exact locked Playwright version using existing cache actions", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-cache-"));
  try {
    const key = "playwright-${{ runner.os }}-${{ runner.arch }}-chromium-${{ steps.playwright.outputs.version }}";
    const restoreAction = workflow.jobs.backend.steps.find(s => s.id === "rust-cache").uses;
    const saveAction = workflow.jobs["backend-cache"].steps.find(s => s.uses?.startsWith("actions/cache/save@")).uses;
    for (const job of [workflow.jobs.web, workflow.jobs.states]) {
      const version = job.steps.find(s => s.id === "playwright");
      assert.ok(version);
      const output = path.join(dir, "output");
      writeFileSync(output, "");
      writeFileSync(path.join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/playwright-core": { version: "1.2.3" } } }));
      const result = spawnSync("bash", ["-e", "-c", version.run], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), "version=1.2.3\n");
      const restore = job.steps.find(s => s.id === "playwright-cache");
      assert.equal(restore.uses, restoreAction);
      assert.deepEqual(restore.with, { path: "~/.cache/ms-playwright", key });
      const install = job.steps.find(s => s.name === "Chromium headless shell for browser-backed tests");
      assert.ok(install && !install.if, "OS fonts must install even on a browser cache hit");
      assert.ok(job.steps.indexOf(restore) < job.steps.indexOf(install));
      assert.ok(!job.steps.some(s => s.uses === saveAction));
      const writer = workflow.jobs["dev-artifacts"];
      const save = writer.steps.find(s => s.uses === saveAction);
      assert.deepEqual(save.with, { path: "~/.cache/ms-playwright", key });
      assert.match(writer.if, /github.event_name == 'push'/);
      assert.equal(save.if, "needs.affected.outputs.web == 'true'");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("browser install reports elapsed seconds on success and failure without hiding its exit status", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "browser-install-"));
  try {
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin/npx"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_ARGS"\nexit "$INSTALL_STATUS"\n', { mode: 0o755 });
    for (const job of [workflow.jobs.states, workflow.jobs.web]) {
      const install = job.steps.find(s => s.name === "Chromium headless shell for browser-backed tests");
      assert.ok(install);
      for (const status of [0, 42]) {
        const summary = path.join(dir, "summary"), args = path.join(dir, "args");
        writeFileSync(summary, "");
        const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", install.run], { cwd: dir, encoding: "utf8", env: {
          ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary, TEST_ARGS: args, INSTALL_STATUS: String(status),
        } });
        assert.equal(result.status, status, result.stderr);
        assert.match(readFileSync(summary, "utf8"), /Playwright Chromium install: \d+s \(includes OS dependencies\)/);
        assert.deepEqual(readFileSync(args, "utf8").trim().split("\n"), ["playwright", "install", "--with-deps", "--only-shell", "chromium"]);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

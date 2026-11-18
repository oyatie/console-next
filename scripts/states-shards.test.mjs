// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { RUN_HEADROOM } from "./states-shards.mjs";
import { listedTests } from "./e2e-timings.mjs";

const historyFile = process.env.STATES_TIMINGS_HISTORY_FILE ?? ".cache/states-history.json";
const settings = { setupAllowanceSeconds: 120, budgetSeconds: 300, startupSeconds: 40, workers: 2, defaultTestSeconds: 10, specs: {} };
const report = (counts, seconds = 4) => ({
  errors: [],
  suites: Object.entries(counts).map(([file, count]) => ({ file, specs: Array.from({ length: count }, (_, i) => ({
    title: `case ${i}`, tests: [{ projectName: "", expectedStatus: "passed", results: [{ status: "passed", duration: seconds * 1000 }] }],
  })) })),
});
const load = () => import("./states-shards.mjs");
const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));

test("failed state shards upload traces and failure files separately from JSON reports with bounded retention", () => {
  const uploads = workflow.jobs.states.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
  const report = uploads.find(step => step.with.name === "states-report-${{ matrix.shard }}");
  assert.equal(report.if, "${{ !cancelled() }}");
  assert.equal(report.with.path, ".cache/states-report-${{ matrix.shard }}.json");
  const failures = uploads.find(step => step.with.name === "states-failures-${{ matrix.shard }}");
  assert.ok(failures, "failed shards must publish Playwright failure files");
  assert.equal(failures.uses, report.uses);
  assert.equal(failures.if, "${{ failure() }}");
  assert.equal(failures.with.path, "test-results-mock");
  assert.ok(Number.isInteger(failures.with["retention-days"]) && failures.with["retention-days"] > 0 && failures.with["retention-days"] <= 7);
  assert.equal(failures.with["if-no-files-found"], "ignore");
});

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

test("unknown estimates that exceed whole-spec or shard capacity name missing CI measurements", async () => {
  const { planStates } = await load();
  // The run limit leaves a 480 s execution timeout after headroom.
  const timings = { ...settings, timeoutSeconds: 600, runLimitSeconds: 480 * RUN_HEADROOM, maxShards: 1,
    specs: { "mock/known.spec.ts": { seconds: 20, tests: 1 } } };
  assert.throws(() => planStates(report({ "states/new.spec.ts": 30 }), timings), /STATES_SPEC_OVER_BUDGET.*states\/new\.spec\.ts.*CI measurements/i);
  assert.throws(() => planStates(report({ "mock/known.spec.ts": 1, "states/new.spec.ts": 22 }), timings), /STATES_TIMEOUT_LIMIT.*CI measurements.*states\/new\.spec\.ts/i);
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

test("committed timings contain settings and a floor, never per-spec measurements", () => {
  const timings = JSON.parse(readFileSync(new URL("../e2e/mock/timings.json", import.meta.url), "utf8"));
  assert.equal(timings.specs, undefined);
  assert.ok(timings.defaultTestSeconds > 0);
});

test("the configured runner cap adds a sixth shard before measured headroom is exhausted", async () => {
  const { planStates, filesForShard } = await load();
  const timings = JSON.parse(readFileSync(new URL("../e2e/mock/timings.json", import.meta.url), "utf8"));
  const specs = Object.fromEntries(Array.from({ length: 126 }, (_, i) => [`mock/${i}.spec.ts`, { seconds: 30, tests: 10 }]));
  const input = report(Object.fromEntries(Object.keys(specs).map(file => [file, 10])));
  const measured = { workers: timings.workers, specs };
  const planned = planStates(input, timings, measured);
  assert.equal(planned.shards.length, 6);
  assert.ok(planned.shards.every(s => s.seconds <= Math.floor(timings.runLimitSeconds / RUN_HEADROOM) * 0.85));
  assert.deepEqual(planned.shards.flatMap(s => filesForShard(planned, s.id)).sort(), Object.keys(specs).map(f => `e2e/${f}`).sort());
});

test("CI checks capacity only on dev after publishing fresh measurements", () => {
  const steps = workflow.jobs["states-plan"].steps;
  assert.ok(steps.some(s => s.run?.includes("states-shards.mjs restore")));
  assert.ok(!steps.some(s => s.env?.STATES_CHECK_CAPACITY === "1"));
  const refresh = workflow.jobs["states-timings"].steps;
  const upload = refresh.findIndex(s => s.with?.name === "states-timings");
  const check = refresh.findIndex(s => s.env?.STATES_CHECK_CAPACITY === "1");
  assert.ok(upload >= 0 && check > upload, "publish measurements even when the capacity alert fails");
  assert.equal(refresh[check].run, "node --test scripts/states-shards.test.mjs");
  assert.equal(refresh[check].env.STATES_TIMINGS_FILE, ".cache/states-timings/timings.json");
});

test("artifact measurements cover a spec that grew on dev without editing settings", async () => {
  const { planStates } = await load();
  const { specs: ignored, ...floor } = settings;
  const measured = { workers: floor.workers, specs: { "mock/a.spec.ts": { seconds: 20, tests: 10 } } };
  const planned = planStates(report({ "mock/a.spec.ts": 10 }), floor, measured);
  assert.equal(planned.shards[0].seconds, floor.startupSeconds + 20);
  assert.equal(planStates(report({ "mock/a.spec.ts": 11 }), floor, measured).shards[0].seconds, floor.startupSeconds + 25);
});

test("the real suite allows 30 added tests and ten percent timing drift within the runner cap", async t => {
  if (process.env.STATES_CHECK_CAPACITY !== "1") return t.skip("capacity is checked on dev pushes with fresh measurements");
  const { checkHeadroom, planStates, filesForShard } = await load();
  const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config=e2e/mock/playwright.config.ts", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const discovered = JSON.parse(result.stdout);
  const timings = JSON.parse(readFileSync(new URL("../e2e/mock/timings.json", import.meta.url), "utf8"));
  const runs = existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, "utf8")).runs : [];
  const currentFile = process.env.STATES_TIMINGS_FILE ?? ".cache/states-timings/timings.json";
  const current = existsSync(currentFile) ? JSON.parse(readFileSync(currentFile, "utf8")) : undefined;
  const checked = checkHeadroom(discovered, timings, runs, process.env.GITHUB_STEP_SUMMARY, current);
  if (!checked) console.warn("::warning::Insufficient dev timing history; headroom not judged; checking growth against available measurements");
  const artifact = checked?.timings ?? [current, ...runs.map(run => run.timings)].find(measured => measured?.workers === timings.workers && Object.keys(measured.specs ?? {}).length);
  if (!artifact) return t.skip("no compatible measurements available for the growth guard");
  const timeoutSeconds = Math.floor(timings.runLimitSeconds / RUN_HEADROOM);
  assert.equal(timings.timeoutSeconds, 1080, "suite growth must fit without extending the planning limit");
  for (const drift of [1, 1.1]) {
    const input = { ...discovered, suites: [...discovered.suites, ...report({ "states/growth.spec.ts": 30 }).suites] };
    const measured = { workers: timings.workers, specs: Object.fromEntries(Object.entries(artifact.specs).map(([file, entry]) => [file, { ...entry, seconds: entry.seconds * drift }])) };
    const plan = planStates(input, timings, measured);
    t.diagnostic(`30 added tests, drift ${drift}: ${plan.shards.length} shards, maximum ${Math.max(...plan.shards.map(s => s.seconds)).toFixed(1)}s`);
    assert.ok(plan.shards.length <= timings.maxShards);
    assert.ok(plan.budgetSeconds >= timings.budgetSeconds && plan.budgetSeconds <= timeoutSeconds);
    assert.ok(plan.budgetSeconds * RUN_HEADROOM <= plan.runTimeoutMinutes * 60);
    assert.equal(plan.jobTimeoutMinutes, Math.ceil(timings.setupAllowanceSeconds / 60) + plan.runTimeoutMinutes);
    assert.deepEqual(plan.shards.flatMap(s => filesForShard(plan, s.id)).sort(), input.suites.map(s => `e2e/${s.file}`).sort());
  }
  assert.equal(timeoutSeconds, 937);
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
    for (const file of ["scripts/states-shards.mjs", "scripts/e2e-timings.mjs", ".github/ci-proof.cjs"]) cpSync(new URL(`../${file}`, import.meta.url), path.join(dir, file));
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
    for (const file of ["scripts/states-shards.mjs", "scripts/e2e-timings.mjs", ".github/ci-proof.cjs"]) cpSync(new URL(`../${file}`, import.meta.url), path.join(dir, file));
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

const artifact = (id, extra = {}) => ({ id, expired: false, created_at: new Date(id * 1000).toISOString(),
  workflow_run: { id, head_branch: "dev", repository_id: 1, head_repository_id: 1 }, ...extra });
const zip = data => {
  const result = spawnSync("python3", ["-c", "import io,sys,zipfile; b=io.BytesIO(); z=zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED); z.writestr('timings.json',sys.stdin.read()); z.close(); sys.stdout.buffer.write(b.getvalue())"], { input: JSON.stringify(data) });
  assert.equal(result.status, 0, result.stderr.toString());
  return result.stdout;
};
const config = { apiUrl: "https://api.github.com", repository: "example/console", repositoryId: 1, token: "test-token" };
// Producing runs are successful CI pushes on dev's history unless `runs` overrides a run's fields.
const devRun = (url, runs = {}) => {
  if (url.endsWith("/branches/dev")) return Response.json({ commit: { sha: "tip" } });
  if (url.includes("/compare/")) return Response.json({ status: url.includes("/compare/unmerged...") ? "diverged" : "ahead" });
  const id = url.match(/\/actions\/runs\/(\d+)$/)?.[1];
  return id && Response.json({ id: Number(id), path: ".github/workflows/ci.yml", event: "push", status: "completed", conclusion: "success",
    head_branch: "dev", head_sha: `sha${id}`, repository: { id: 1 }, head_repository: { id: 1 }, ...runs[id] });
};

const capacitySettings = { ...settings, headroomRuns: 5, maxShards: 2, timeoutSeconds: 600, runLimitSeconds: 960 };
const capacitySuite = report({ "mock/a.spec.ts": 1, "states/b.spec.ts": 1 });
const capacityRun = (runId, seconds = 420) => ({ runId, timings: { workers: settings.workers,
  specs: Object.fromEntries(["mock/a.spec.ts", "states/b.spec.ts"].map(file => [file, { seconds, tests: 1 }])) } });
const capacityHistory = seconds => Array.from({ length: 5 }, (_, i) => capacityRun(5 - i, seconds));
const withSummary = check => {
  const dir = mkdtempSync(path.join(tmpdir(), "states-capacity-"));
  const summary = path.join(dir, "summary.md");
  try { return check(summary); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("median headroom survives one slow timing file that fails the one-run limit", async () => {
  const { checkHeadroom, planStates } = await load();
  withSummary(summary => {
    const dir = path.dirname(summary);
    const runs = capacityHistory(420);
    runs[0] = capacityRun(5, 480);
    const files = runs.map(run => {
      const file = path.join(dir, `${run.runId}.json`);
      writeFileSync(file, JSON.stringify(run));
      return file;
    });
    const history = files.map(file => JSON.parse(readFileSync(file, "utf8")));
    const old = planStates(capacitySuite, capacitySettings, history[0].timings);
    assert.ok(Math.max(...old.shards.map(s => s.seconds)) > capacitySettings.timeoutSeconds * 0.85);
    const result = checkHeadroom(capacitySuite, capacitySettings, history, summary);
    assert.equal(result.headroom, 100 * (1 - 460 / 600));
    assert.equal(result.timings.specs["mock/a.spec.ts"].seconds, 420);
    assert.match(readFileSync(summary, "utf8"), /23\.3%.*5.*dev runs/);
  });
});

test("consistently slow timing files warn without failing and publish the measured headroom", async t => {
  const { checkHeadroom } = await load();
  const warning = t.mock.method(console, "warn", () => {});
  withSummary(summary => {
    const checked = checkHeadroom(capacitySuite, capacitySettings, capacityHistory(480), summary);
    assert.ok(checked.headroom < 15);
    assert.deepEqual(warning.mock.calls.map(call => call.arguments), [["::warning::STATES_HEADROOM_EXHAUSTED: the measured suite needs at least fifteen percent headroom"]]);
    assert.match(readFileSync(summary, "utf8"), /13\.3%/);
    assert.match(readFileSync(summary, "utf8"), /15%/);
  });
});

test("capacity below twenty percent reports the next shard or faster specs before the limit", async () => {
  const { checkHeadroom } = await load();
  withSummary(summary => {
    assert.ok(checkHeadroom(capacitySuite, capacitySettings, capacityHistory(450), summary).headroom < 20);
    assert.match(readFileSync(summary, "utf8"), /another shard or faster slow specs is due/i);
  });
});

test("the fifteen percent threshold remains inclusive and twenty percent needs no capacity warning", async t => {
  const { checkHeadroom } = await load();
  const warning = t.mock.method(console, "warn", () => {});
  withSummary(summary => {
    assert.ok(checkHeadroom(capacitySuite, capacitySettings, capacityHistory(470), summary));
    assert.equal(warning.mock.callCount(), 0);
    assert.ok(checkHeadroom(capacitySuite, capacitySettings, capacityHistory(470.1), summary));
    assert.equal(warning.mock.callCount(), 1);
  });
  withSummary(summary => {
    checkHeadroom(capacitySuite, capacitySettings, capacityHistory(440), summary);
    assert.doesNotMatch(readFileSync(summary, "utf8"), /another shard/);
    assert.equal(warning.mock.callCount(), 1);
  });
});

test("fewer than three distinct compatible runs leave capacity unjudged", async () => {
  const { checkHeadroom } = await load();
  const workers = capacityHistory(420).slice(0, 3);
  workers[0].timings.workers = 1;
  for (const runs of [[], workers, capacityHistory(420).slice(0, 2), Array(5).fill(capacityRun(1, 420))]) {
    withSummary(summary => {
      assert.equal(checkHeadroom(capacitySuite, capacitySettings, runs, summary), undefined);
      assert.match(readFileSync(summary, "utf8"), /Insufficient history/);
      assert.match(readFileSync(summary, "utf8"), /headroom not judged/i);
      assert.doesNotMatch(readFileSync(summary, "utf8"), /Typical headroom/);
    });
  }
});

test("changing test counts still judges normalized medians and catches sustained slowdown", async () => {
  const { checkHeadroom } = await load();
  const counts = { "mock/a.spec.ts": 12, "states/b.spec.ts": 10 };
  const runs = capacityHistory().map((run, i) => ({ ...run, timings: { ...run.timings,
    specs: Object.fromEntries(Object.keys(counts).map(file => {
      const tests = file === "mock/a.spec.ts" ? 12 - i : 10;
      return [file, { tests, seconds: tests * 35 }];
    })),
  } }));
  withSummary(summary => {
    const checked = checkHeadroom(report(counts), capacitySettings, runs, summary);
    assert.equal(checked.timings.specs["mock/a.spec.ts"].seconds, 420);
    assert.match(readFileSync(summary, "utf8"), /Typical headroom/);
    const slow = runs.map(run => ({ ...run, timings: { ...run.timings,
      specs: Object.fromEntries(Object.entries(run.timings.specs).map(([file, entry]) => [file, { ...entry, seconds: entry.seconds * 1.15 }])),
    } }));
    assert.ok(checkHeadroom(report(counts), capacitySettings, slow, summary).headroom < 15);
  });
});

test("three samples suffice while newer specs use the planner P95 estimate", async () => {
  const { checkHeadroom, planStates } = await load();
  const runs = capacityHistory(420).slice(0, 3);
  delete runs[0].timings.specs["states/b.spec.ts"];
  const checked = checkHeadroom(capacitySuite, capacitySettings, runs, null);
  assert.ok(checked);
  assert.equal(checked.timings.specs["states/b.spec.ts"], undefined);
  assert.deepEqual(checked.plan, planStates(capacitySuite, capacitySettings, checked.timings));
  assert.deepEqual(checked.plan.shards.flatMap(shard => shard.files).sort(), ["e2e/mock/a.spec.ts", "e2e/states/b.spec.ts"]);
});

test("sparse specs use this push's per-test measurements scaled to current counts", async () => {
  const { checkHeadroom } = await load();
  const specs = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`states/fixture-${i}.spec.ts`, { tests: 10, seconds: i ? 50 : 200 }]));
  const file = "states/new.spec.ts";
  const counts = { ...Object.fromEntries(Object.entries(specs).map(([file, entry]) => [file, entry.tests])), [file]: 10 };
  const current = { workers: settings.workers, specs: { ...specs, "states/fixture-0.spec.ts": { tests: 10, seconds: 1 }, [file]: { tests: 5, seconds: 25 } } };
  for (const samples of [0, 1, 2]) withSummary(summary => {
    const runs = capacityHistory().map((run, i) => ({ ...run, timings: { workers: settings.workers,
      specs: { ...specs, ...(i < samples ? { [file]: { tests: 10, seconds: 200 } } : {}) },
    } }));
    const checked = checkHeadroom(report(counts), capacitySettings, runs, summary, current);
    assert.ok(checked.headroom >= 15);
    assert.deepEqual(checked.timings.specs[file], { tests: 10, seconds: 50 });
    assert.equal(checked.timings.specs["states/fixture-0.spec.ts"].seconds, 200);
    const text = readFileSync(summary, "utf8");
    assert.match(text, /measured on this push only.*states\/new\.spec\.ts/i);
    assert.doesNotMatch(text, /P95 estimate/);
  });
  const runs = capacityHistory().map(run => ({ ...run, timings: { workers: settings.workers, specs } }));
  assert.throws(() => checkHeadroom(report(counts), capacitySettings, runs, null,
    { ...current, specs: { ...current.specs, "states/fixture-0.spec.ts": { tests: 10, seconds: 0 } } }), /STATES_INVALID_TIMINGS/);
});

test("a sparse spec missing from this push is priced at P95 and named in the summary", async () => {
  const { checkHeadroom, planStates } = await load();
  const file = "states/new.spec.ts";
  const input = report({ "mock/a.spec.ts": 1, "states/b.spec.ts": 1, [file]: 1 });
  withSummary(summary => {
    const runs = capacityHistory(200);
    const checked = checkHeadroom(input, capacitySettings, runs, summary, runs[0].timings);
    assert.equal(checked.timings.specs[file], undefined);
    assert.deepEqual(checked.plan, planStates(input, capacitySettings, runs[0].timings));
    assert.match(readFileSync(summary, "utf8"), /P95 estimate.*states\/new\.spec\.ts/);
    assert.doesNotMatch(readFileSync(summary, "utf8"), /measured on this push only/i);
    const incompatible = { workers: settings.workers + 1, specs: { [file]: { tests: 1, seconds: 1 } } };
    assert.deepEqual(checkHeadroom(input, capacitySettings, runs, null, incompatible).plan, checked.plan);
  });
});

test("a dev-sized suite plus three new specs at median cost keeps measured headroom", async () => {
  const { checkHeadroom } = await load();
  const timings = JSON.parse(readFileSync(new URL("../e2e/mock/timings.json", import.meta.url), "utf8"));
  const specs = Object.fromEntries(Array.from({ length: 178 }, (_, i) => [`states/fixture-${i}.spec.ts`, { tests: 15, seconds: 15 * (i < 10 ? 3.76 : 1.45) }]));
  const current = { workers: timings.workers, specs: { ...specs, ...Object.fromEntries(Array.from({ length: 3 }, (_, i) => [`states/new-${i}.spec.ts`, { tests: 32, seconds: 32 * 1.45 }])) } };
  const input = report(Object.fromEntries(Object.entries(current.specs).map(([file, entry]) => [file, entry.tests])));
  const runs = capacityHistory().map(run => ({ ...run, timings: { workers: timings.workers, specs } }));
  withSummary(summary => {
    const checked = checkHeadroom(input, timings, runs, summary, current);
    assert.equal(checked.plan.shards.length, timings.maxShards);
    assert.ok(checked.headroom >= 15 && checked.headroom < 20);
    assert.match(readFileSync(summary, "utf8"), /measured on this push only.*new-0.*new-1.*new-2/i);
    assert.ok(checkHeadroom(input, timings, runs, null).headroom < 15);
  });
});

test("the dev growth guard runs with fresh or recent measurements when history is insufficient", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "states-growth-"));
  try {
    for (const folder of ["scripts", ".github/workflows", "e2e/mock", "node_modules/@playwright/test"])
      mkdirSync(path.join(dir, folder), { recursive: true });
    for (const file of ["scripts/states-shards.mjs", "scripts/states-shards.test.mjs", "scripts/e2e-timings.mjs", ".github/ci-proof.cjs", ".github/workflows/ci.yml", "e2e/mock/timings.json"])
      cpSync(file, path.join(dir, file));
    symlinkSync(path.resolve("node_modules/js-yaml"), path.join(dir, "node_modules/js-yaml"), "dir");
    writeFileSync(path.join(dir, "node_modules/@playwright/test/cli.js"), `console.log(${JSON.stringify(JSON.stringify(report({ "mock/a.spec.ts": 100, "states/b.spec.ts": 100 })))});`);
    const history = path.join(dir, "history.json"), current = path.join(dir, "current.json");
    const measured = seconds => ({ workers: settings.workers, specs: Object.fromEntries(["mock/a.spec.ts", "states/b.spec.ts"].map(file => [file, { tests: 100, seconds }])) });
    for (const source of ["current", "history"]) for (const seconds of [800, 830]) {
      writeFileSync(history, JSON.stringify({ runs: source === "history" ? [{ runId: 1, timings: measured(seconds) }] : [] }));
      if (source === "current") writeFileSync(current, JSON.stringify(measured(seconds)));
      else rmSync(current, { force: true });
      const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=the real suite allows", "scripts/states-shards.test.mjs"], {
        cwd: dir, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, CI: "true", STATES_CHECK_CAPACITY: "1", STATES_TIMINGS_FILE: current,
          STATES_TIMINGS_HISTORY_FILE: history, GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") },
      });
      assert.match(result.stdout, /Insufficient history/, result.stderr);
      assert.doesNotMatch(result.stdout, /# SKIP/);
      assert.equal(result.status, seconds === 800 ? 0 : 1, result.stdout + result.stderr);
      if (seconds === 830) assert.match(result.stdout, /STATES_SPEC_OVER_BUDGET/);
    }
    writeFileSync(path.join(dir, "node_modules/@playwright/test/cli.js"), `console.log(${JSON.stringify(JSON.stringify(report({ "mock/a.spec.ts": 100, "states/b.spec.ts": 120 })))});`);
    writeFileSync(history, JSON.stringify({ runs: capacityHistory().map(run => ({ ...run,
      timings: { workers: settings.workers, specs: { "mock/a.spec.ts": { tests: 100, seconds: 700 } } },
    })) }));
    writeFileSync(current, JSON.stringify(measured(100)));
    const result = spawnSync(process.execPath, ["--test", "--test-name-pattern=the real suite allows", "scripts/states-shards.test.mjs"], {
      cwd: dir, encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: undefined, CI: "true", STATES_CHECK_CAPACITY: "1", STATES_TIMINGS_FILE: current,
        STATES_TIMINGS_HISTORY_FILE: history, GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /measured on this push only.*states\/b\.spec\.ts/i);
    assert.doesNotMatch(result.stdout, /# SKIP/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API outages use cached dev timings to plan the real suite instead of the bootstrap floor", async t => {
  const { restoreDevTimings, planStates, filesForShard } = await load();
  t.mock.method(console, "warn", () => {});
  const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config=e2e/mock/playwright.config.ts", "--list", "--reporter=json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  const discovered = JSON.parse(result.stdout);
  const timings = JSON.parse(readFileSync("e2e/mock/timings.json", "utf8"));
  const counts = {};
  for (const { file } of listedTests(discovered)) counts[file] = (counts[file] ?? 0) + 1;
  const cachedTimings = { workers: timings.workers, specs: Object.fromEntries(Object.entries(counts).map(([file, tests]) => [file, { tests, seconds: tests }])) };
  const restored = await restoreDevTimings(timings, { ...config, cachedTimings, summary: null }, async () => new Response("unavailable", { status: 503 }));
  assert.deepEqual(restored.timings, cachedTimings);
  const planned = planStates(discovered, timings, restored.timings);
  assert.deepEqual(planned.shards.flatMap(shard => filesForShard(planned, shard.id)).sort(), discovered.suites.map(suite => `e2e/${suite.file}`).sort());
  const dir = mkdtempSync(path.join(tmpdir(), "states-cached-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cached = path.join(dir, "timings.json"), stub = path.join(dir, "outage.mjs");
  writeFileSync(cached, JSON.stringify(cachedTimings));
  writeFileSync(stub, 'globalThis.fetch = async () => new Response("unavailable", { status: 503 });');
  const cli = spawnSync(process.execPath, ["--import", stub, "scripts/states-shards.mjs", "restore", "e2e/mock/timings.json", cached], {
    encoding: "utf8", env: { ...process.env, GITHUB_API_URL: config.apiUrl, GITHUB_REPOSITORY: config.repository,
      GITHUB_REPOSITORY_ID: String(config.repositoryId), GH_TOKEN: config.token, GITHUB_STEP_SUMMARY: path.join(dir, "summary.md") },
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stderr, /using cached dev timings/);
  assert.deepEqual(JSON.parse(readFileSync(cached, "utf8")), cachedTimings);
});

test("cached fallback validates durations and ignores incompatible workers", async t => {
  const { restoreDevTimings } = await load();
  t.mock.method(console, "warn", () => {});
  const request = async () => new Response("unavailable", { status: 503 });
  const cachedTimings = capacityRun(1).timings;
  cachedTimings.specs["mock/a.spec.ts"].seconds = -1;
  await assert.rejects(restoreDevTimings(capacitySettings, { ...config, cachedTimings, summary: null }, request), /STATES_INVALID_TIMINGS/);
  const fallback = await restoreDevTimings(capacitySettings, { ...config, cachedTimings: { ...capacityRun(1).timings, workers: 1 }, summary: null }, request);
  assert.deepEqual(fallback.timings, { workers: capacitySettings.workers, specs: {} });
});

test("cached timings cannot bypass API refusals or replace fresh trusted measurements", async () => {
  const { restoreDevTimings } = await load();
  const cachedTimings = capacityRun(1).timings;
  await assert.rejects(restoreDevTimings(capacitySettings, { ...config, cachedTimings }, async () => new Response("denied", { status: 403 })), /STATES_TIMINGS_FETCH.*403/);
  const measured = capacityRun(2, 450).timings;
  const request = async url => devRun(url) ?? new Response(url.endsWith("/zip") ? zip(measured) : JSON.stringify({ artifacts: [artifact(2)] }));
  assert.deepEqual((await restoreDevTimings(capacitySettings, { ...config, cachedTimings }, request)).timings, measured);
});

test("CI saves dev measurements before capacity checks and restores the cache before the API", () => {
  const steps = workflow.jobs["states-plan"].steps;
  const restore = steps.findIndex(step => step.uses?.startsWith("actions/cache/restore") && step.with?.key?.startsWith("states-timings-"));
  assert.ok(restore >= 0);
  assert.ok(restore < steps.findIndex(step => step.run?.includes("states-shards.mjs restore")));
  assert.equal(steps[restore].with.path, ".cache/states-timings/timings.json");
  assert.equal(steps[restore]["continue-on-error"], true);
  assert.equal(steps[restore].with["restore-keys"], "states-timings-");
  const refresh = workflow.jobs["states-timings"].steps;
  const save = refresh.findIndex(step => step.uses?.startsWith("actions/cache/save") && step.with?.key?.startsWith("states-timings-"));
  assert.ok(save > refresh.findIndex(step => step.run?.includes("states-shards.mjs refresh")));
  assert.ok(save < refresh.findIndex(step => step.env?.STATES_CHECK_CAPACITY === "1"));
  assert.equal(refresh[save].with.path, steps[restore].with.path);
  assert.equal(refresh[save]["continue-on-error"], true);
  assert.equal(refresh[save].with.key, "states-timings-${{ github.run_id }}");
  assert.match(workflow.jobs["states-timings"].if, /github.event_name == 'push'/);
  assert.deepEqual(workflow.on.push.branches, ["dev"]);
});

test("medians are per spec and only the recent configured window is measured", async () => {
  const { checkHeadroom } = await load();
  const runs = capacityHistory(420);
  runs[0].timings.specs["mock/a.spec.ts"].seconds = 480;
  runs[1].timings.specs["states/b.spec.ts"].seconds = 480;
  runs.push(...Array.from({ length: 5 }, (_, i) => capacityRun(10 + i, 550)));
  const measured = checkHeadroom(capacitySuite, capacitySettings, runs, null);
  assert.deepEqual(measured.timings.specs, capacityRun(1).timings.specs);
  const even = checkHeadroom(capacitySuite, { ...capacitySettings, headroomRuns: 4 },
    [400, 420, 440, 460].map((seconds, i) => capacityRun(i + 1, seconds)), null);
  assert.equal(even.timings.specs["mock/a.spec.ts"].seconds, 430);
});

test("capacity rejects invalid history settings and malformed measurements", async () => {
  const { checkHeadroom } = await load();
  for (const headroomRuns of [undefined, 0, 1, 2, 3.5, "5"]) {
    assert.throws(() => checkHeadroom(capacitySuite, { ...capacitySettings, headroomRuns }, capacityHistory()), /STATES_INVALID_TIMINGS/);
  }
  const runs = capacityHistory();
  runs[0].timings.specs["mock/a.spec.ts"].seconds = -1;
  assert.throws(() => checkHeadroom(capacitySuite, capacitySettings, runs), /STATES_INVALID_TIMINGS/);
  assert.throws(() => checkHeadroom(capacitySuite, capacitySettings, {}), /STATES_INVALID_TIMINGS/);
});

test("history restores distinct compatible trusted dev runs without scaling or bootstrap samples", async () => {
  const { restoreDevTimings } = await load();
  const requests = [];
  const artifacts = [artifact(10), artifact(9), artifact(8), artifact(7), artifact(6), artifact(5), artifact(4),
    artifact(3, { workflow_run: { id: 4, head_branch: "dev" } }), artifact(2), artifact(1)];
  const runs = { 10: { status: "in_progress" }, 9: { event: "pull_request" }, 8: { head_sha: "unmerged" },
    6: { conclusion: "failure" }, 5: { head_repository: { id: 9 } } };
  const request = async url => {
    requests.push(url);
    const id = Number(url.match(/artifacts\/(\d+)\/zip$/)?.[1]);
    return devRun(url, runs) ?? new Response(id ? zip({ ...capacityRun(id).timings, workers: id === 7 ? 1 : 2 }) : JSON.stringify({ artifacts }));
  };
  const restored = await restoreDevTimings(capacitySettings, { ...config, history: true }, request);
  assert.deepEqual(restored.runs.map(run => run.runId), [6, 4, 2, 1]);
  assert.ok(restored.runs.every(run => run.timings.workers === 2));
  assert.ok(!requests.some(url => url.endsWith("/3/zip")), "duplicate runs cannot count twice");
  const empty = await restoreDevTimings(capacitySettings, { ...config, history: true }, async () => Response.json({ artifacts: [] }));
  assert.deepEqual(empty.runs, []);
});

test("history restoration stops at the configured window and CI supplies it to the capacity check", async () => {
  const { restoreDevTimings } = await load();
  let downloads = 0;
  const request = async url => devRun(url) ?? new Response(url.endsWith("/zip")
    ? (downloads++, zip(capacityRun(downloads).timings))
    : JSON.stringify({ artifacts: Array.from({ length: 9 }, (_, i) => artifact(i + 1)) }));
  const restored = await restoreDevTimings(capacitySettings, { ...config, history: true }, request);
  assert.equal(downloads, capacitySettings.headroomRuns);
  assert.deepEqual(restored.runs.map(run => run.runId), [9, 8, 7, 6, 5]);
  const steps = workflow.jobs["states-timings"].steps;
  const restore = steps.findIndex(s => s.run?.includes("states-shards.mjs history"));
  const check = steps.findIndex(s => s.env?.STATES_CHECK_CAPACITY === "1");
  assert.ok(restore > steps.findIndex(s => s.with?.name === "states-timings"));
  assert.ok(restore < check);
  assert.equal(steps[check].env.STATES_TIMINGS_HISTORY_FILE, ".cache/states-history.json");
});

for (const history of [false, true]) for (const site of ["list", "metadata", "download"]) {
  const failures = {
    "HTTP 503": () => new Response("unavailable", { status: 503 }),
    "HTTP 429": () => new Response("rate limited", { status: 429 }),
    "network error": () => { throw new TypeError("fetch failed"); },
    "body interrupted": () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("connection reset")); } })),
  };
  for (const [outage, fail] of Object.entries(failures)) test(`${history ? "history" : "restore"} warns and falls back on ${site} ${outage}`, async t => {
    const { restoreDevTimings, checkHeadroom, planStates, filesForShard } = await load();
    const dir = mkdtempSync(path.join(tmpdir(), "states-outage-"));
    const summary = path.join(dir, "summary.md");
    const previous = process.env.GITHUB_STEP_SUMMARY;
    process.env.GITHUB_STEP_SUMMARY = summary;
    t.after(() => {
      if (previous === undefined) delete process.env.GITHUB_STEP_SUMMARY;
      else process.env.GITHUB_STEP_SUMMARY = previous;
      rmSync(dir, { recursive: true, force: true });
    });
    const warnings = [];
    t.mock.method(console, "warn", message => warnings.push(message));
    let failed = false, attempts = 0;
    const request = async url => {
      assert.equal(failed, false, "an outage must stop fetching without retries");
      const matches = site === "list" ? url.includes("/actions/artifacts?")
        : site === "metadata" ? url.includes("/actions/runs/") : url.endsWith("/zip");
      if (matches) { failed = true; attempts++; return fail(); }
      return devRun(url) ?? Response.json({ artifacts: [artifact(1)] });
    };
    const restored = await restoreDevTimings(capacitySettings, { ...config, history }, request);
    assert.equal(attempts, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^::warning::/);
    const reason = outage === "body interrupted" ? "connection reset" : outage === "network error" ? "fetch failed" : outage;
    assert.ok(warnings[0].includes(reason), warnings[0]);
    assert.ok(readFileSync(summary, "utf8").includes(reason));
    if (history) {
      assert.deepEqual(restored, { runs: [] });
      assert.equal(checkHeadroom(capacitySuite, capacitySettings, restored.runs, summary), undefined);
      assert.match(warnings[0], /Insufficient history/);
      assert.match(readFileSync(summary, "utf8"), /Insufficient history.*headroom not judged/);
    } else {
      assert.deepEqual(restored, { timings: { workers: capacitySettings.workers, specs: {} } });
      assert.match(warnings[0], /bootstrap floor/);
      const plan = planStates(capacitySuite, capacitySettings, restored.timings);
      assert.deepEqual(plan.shards.flatMap(shard => filesForShard(plan, shard.id)).sort(), ["e2e/mock/a.spec.ts", "e2e/states/b.spec.ts"]);
    }
  });
}

test("an outage after partial history or pagination discards incomplete measurements", async t => {
  const { restoreDevTimings } = await load();
  t.mock.method(console, "warn", () => {});
  for (const history of [false, true]) {
    let pages = 0, downloads = 0;
    const request = async url => {
      if (url.includes("/actions/artifacts?")) {
        if (!history && ++pages === 2) return new Response("unavailable", { status: 503 });
        return Response.json({ artifacts: Array.from({ length: history ? 3 : 100 }, (_, i) => artifact(i + 1)) });
      }
      if (url.endsWith("/zip")) return ++downloads === 2 ? new Response("unavailable", { status: 503 }) : new Response(zip(capacityRun(3).timings));
      return devRun(url);
    };
    const restored = await restoreDevTimings(capacitySettings, { ...config, history, summary: null }, request);
    assert.deepEqual(restored, history ? { runs: [] } : { timings: { workers: capacitySettings.workers, specs: {} } });
  }
});

test("restore and history still refuse non-rate-limit 4xx responses at every fetch boundary", async () => {
  const { restoreDevTimings } = await load();
  for (const history of [false, true]) for (const site of ["list", "metadata", "download"]) for (const status of [400, 401, 403, 404, 410, 422]) {
    const request = async url => {
      if (site === "list" && url.includes("/actions/artifacts?") || site === "metadata" && url.includes("/actions/runs/") || site === "download" && url.endsWith("/zip"))
        return new Response("refused", { status });
      return devRun(url) ?? Response.json({ artifacts: [artifact(1)] });
    };
    await assert.rejects(restoreDevTimings(capacitySettings, { ...config, history }, request), new RegExp(`STATES_TIMINGS_FETCH.*HTTP ${status}`));
  }
});

test("restore and history still refuse corrupt archives and invalid timings", async () => {
  const { restoreDevTimings } = await load();
  for (const history of [false, true]) for (const [archive, refusal] of [
    ["broken zip", /STATES_TIMINGS_FETCH.*archive/],
    [zip({ workers: 0, specs: capacityRun(1).timings.specs }), /STATES_INVALID_TIMINGS/],
    [zip({ workers: settings.workers, specs: {} }), /STATES_INVALID_TIMINGS/],
    [zip({ workers: settings.workers, specs: { "mock/a.spec.ts": { seconds: -1, tests: 1 } } }), /STATES_INVALID_TIMINGS/],
  ]) {
    const request = async url => devRun(url) ?? new Response(url.endsWith("/zip") ? archive : JSON.stringify({ artifacts: [artifact(1)] }));
    await assert.rejects(restoreDevTimings(capacitySettings, { ...config, history }, request), refusal);
  }
});

test("CI restores the latest compatible unexpired dev artifact across pages", async () => {
  const { restoreDevTimings } = await load();
  const compatible = { workers: settings.workers, specs: { "mock/a.spec.ts": { seconds: 12, tests: 3 } } };
  const pages = [Array.from({ length: 100 }, (_, i) => artifact(i + 10, { expired: true })), [
    artifact(8, { workflow_run: { id: 8, head_branch: "feature" } }), artifact(7), artifact(6), artifact(5),
    artifact(2), artifact(4), artifact(3),
  ]];
  const runs = { 7: { head_repository: { id: 9 } }, 6: { event: "pull_request" }, 5: { head_sha: "unmerged" } };
  const requests = [];
  const request = async (url, options) => {
    requests.push(url);
    assert.equal(options.headers.Authorization, "Bearer test-token");
    const match = url.match(/artifacts\/(\d+)\/zip$/);
    return devRun(url, runs) ?? new Response(match ? zip({ ...compatible, workers: Number(match[1]) === 4 ? 1 : settings.workers })
      : JSON.stringify({ artifacts: pages[Number(new URL(url).searchParams.get("page")) - 1] }));
  };
  const restored = await restoreDevTimings(settings, config, request);
  assert.equal(restored.runId, 3);
  assert.deepEqual(restored.timings, compatible);
  assert.deepEqual(requests.filter(url => url.endsWith("/zip")).map(url => url.match(/artifacts\/(\d+)\/zip$/)[1]), ["4", "3"]);
  const empty = async () => new Response(JSON.stringify({ artifacts: [] }));
  assert.deepEqual((await restoreDevTimings(settings, config, empty)).timings, { workers: settings.workers, specs: {} });
  await assert.rejects(restoreDevTimings(settings, config, async () => new Response("denied", { status: 403 })), /STATES_TIMINGS_FETCH.*403/);
  await assert.rejects(restoreDevTimings(settings, config, async () => new Response("{}")), /STATES_TIMINGS_FETCH.*missing artifact list/);
  const measurements = data => async url => devRun(url) ?? new Response(url.endsWith("/zip") ? zip(data) : JSON.stringify({ artifacts: [artifact(1)] }));
  for (const specs of [undefined, {}, { "../bad": { seconds: 1, tests: 1 } }])
    await assert.rejects(restoreDevTimings(settings, config, measurements({ ...compatible, specs })), /STATES_INVALID_TIMINGS/);
  const brokenArchive = async url => devRun(url) ?? new Response(url.endsWith("/zip") ? "broken zip" : JSON.stringify({ artifacts: [artifact(1)] }));
  await assert.rejects(restoreDevTimings(settings, config, brokenArchive), /STATES_TIMINGS_FETCH.*archive/);
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
    "node --test scripts/cache-retention.test.mjs",
    "node --test scripts/ghcr-retention.test.mjs",
    "node --test scripts/negative-index.test.mjs",
    "python3 scripts/d7_evidence_test.py",
    "node --test scripts/d10-census.test.mjs",
    "python3 scripts/d10_evidence_test.py",
    "python3 scripts/d8_evidence_test.py",
    "python3 scripts/states_evidence_test.py",
    "python3 scripts/pull_measured_evidence_test.py",
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

test("a dev push that failed after publishing still supplies its measurements", async () => {
  const { restoreDevTimings } = await load();
  const measured = { workers: settings.workers, specs: { "mock/a.spec.ts": { seconds: 12, tests: 3 } } };
  const request = async url => devRun(url, { 2: { conclusion: "failure" }, 3: { conclusion: "failure", event: "pull_request" } })
    ?? new Response(url.endsWith("/zip") ? zip(measured) : JSON.stringify({ artifacts: [artifact(3), artifact(2), artifact(1)] }));
  assert.equal((await restoreDevTimings(settings, config, request)).runId, 2);
});

test("restoration scales the newest trusted artifact when workers change", async () => {
  const { restoreDevTimings, planStates } = await load();
  const request = async url => devRun(url) ?? new Response(url.endsWith("/zip")
    ? zip({ workers: 4, specs: { "mock/a.spec.ts": { seconds: 12, tests: 3 } } })
    : JSON.stringify({ artifacts: [artifact(2), artifact(1)] }));
  const restored = await restoreDevTimings(settings, config, request);
  assert.equal(restored.runId, 2);
  assert.deepEqual(restored.timings, { workers: 2, specs: { "mock/a.spec.ts": { seconds: 24, tests: 3 } } });
  assert.equal(planStates(report({ "mock/a.spec.ts": 3 }), settings, restored.timings).shards[0].seconds, 64);
  for (const workers of [0, -1, 1.5, "4"]) {
    await assert.rejects(restoreDevTimings(settings, config, async url => devRun(url) ?? new Response(url.endsWith("/zip")
      ? zip({ workers, specs: { "mock/a.spec.ts": { seconds: 12, tests: 3 } } })
      : JSON.stringify({ artifacts: [artifact(1)] }))), /STATES_INVALID_TIMINGS/);
  }
});

test("artifact pagination is bounded even when the server always returns full pages", async () => {
  const { restoreDevTimings } = await load();
  let pages = 0;
  const restored = await restoreDevTimings(settings, config, async () => {
    assert.ok(++pages <= 5, "artifact lookup must stop after five pages");
    return new Response(JSON.stringify({ artifacts: Array.from({ length: 100 }, () => artifact(1, { expired: true })) }));
  });
  assert.equal(pages, 5);
  assert.deepEqual(restored.timings, { workers: settings.workers, specs: {} });
});

test("a repository without artifacts can bootstrap a fixed suite within the runner cap", async () => {
  const { planStates } = await load();
  const timings = { ...settings, maxShards: 2, timeoutSeconds: 600 };
  const planned = planStates(report({ "mock/a.spec.ts": 30, "mock/b.spec.ts": 30, "mock/c.spec.ts": 30 }), timings);
  assert.ok(planned.shards.length <= timings.maxShards);
  assert.ok(planned.budgetSeconds > timings.budgetSeconds);
});

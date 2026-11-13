// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const root = process.env.CONSOLE_TEST_ROOT ?? path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("live E2E builds one candidate and runs at most four Chromium shards before Firefox", () => {
  const workflow = yaml.load(read(".github/workflows/e2e-live.yml"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.ok(workflow.on.schedule.length);
  assert.equal(workflow.on.merge_group, undefined);
  assert.equal(workflow.concurrency.group, "e2e-live-${{ github.ref }}");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);

  const { build, chromium, firefox } = workflow.jobs;
  const cargo = build.steps.find((step) => step.run?.includes("cargo build"));
  assert.match(cargo.run, /--release/);
  assert.match(cargo.run, /full,e2e-test-support/);
  const artifact = build.steps.find((step) => step.uses?.startsWith("actions\/upload-artifact@"));
  assert.ok(artifact);
  assert.deepEqual(chromium.needs, ["build"]);
  assert.deepEqual(firefox.needs, ["build", "chromium"]);
  assert.match(firefox.if, /needs\.build\.result == 'success'/);
  for (const job of [chromium, firefox]) {
    assert.deepEqual(job.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(job.strategy["max-parallel"], 4);
    assert.ok(job.services.postgres.image.includes("@sha256:"));
    assert.ok(job.steps.some((step) => step.uses?.startsWith("actions\/download-artifact@") && step.with.name === artifact.with.name));
    const run = job.steps.find((step) => step.run?.includes("e2e-live-report.mjs"));
    assert.ok(run);
    assert.match(run.run, /--retries=0/, "live E2E must report flakes instead of retrying them green");
    assert.match(run.env.CONSOLE_DEV_POSTGRES_CONTAINER, /job\.services\.postgres\.id/);
  }
});

test("all three live browser projects exclude backend-free suites while retaining live journeys", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "live-selection-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [project, browser] of [["parallel", "chromium"], ["firefox", "firefox"], ["webkit", "webkit"]]) {
    const output = path.join(directory, `${project}.json`);
    const env = { ...process.env, E2E_BROWSER: browser, PLAYWRIGHT_JSON_OUTPUT_FILE: output };
    delete env.NODE_TEST_CONTEXT;
    const selection = "first-run-solo|error-beacon|coldstart/|mock/|states/|live-renew.server-expiry|layout/layout.spec|perf/.*.test|visual.spec";
    const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test", selection, "--list", `--project=${project}`, "--reporter=json"], {
      cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000,
      env,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(report.errors, []);
    const files = [];
    const visit = suites => suites.forEach(suite => {
      if (suite.file) files.push(suite.file.replaceAll("\\", "/"));
      visit(suite.suites ?? []);
    });
    visit(report.suites);
    for (const file of files) {
      assert.doesNotMatch(file, /(?:^|\/)(?:coldstart|mock|states)\/|live-renew\.server-expiry\.spec\.ts$|(?:^|\/)layout\/layout\.spec\.ts$|(?:^|\/)perf\/.*\.test\.ts$/, `${project}: ${file}`);
      if (browser !== "chromium") assert.doesNotMatch(file, /visual\.spec\.ts/, file);
    }
    for (const spec of ["first-run-solo.spec.ts", "error-beacon.spec.ts"])
      assert.ok(files.some(file => file.endsWith(spec)), `${project} must retain ${spec}`);
  }
});

test("Firefox live discovery preserves Chromium's live scope except visual baselines", { skip: !process.env.E2E_LIVE_INVENTORY }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "live-inventory-"));
  const discover = (browser, config = "playwright.config.ts") => {
    const output = path.join(dir, `${browser}.json`);
    const result = spawnSync(process.execPath, [path.join(root, "node_modules/@playwright/test/cli.js"),
      "test", "--list", `--config=${config}`, `--project=${browser === "firefox" ? "firefox" : "parallel"}`, "--reporter=json"],
    { cwd: root, encoding: "utf8", env: { ...process.env, E2E_BROWSER: browser, PLAYWRIGHT_JSON_OUTPUT_FILE: output } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(report.errors, []);
    const keys = [];
    const visit = (suite, titles = []) => {
      for (const spec of suite.specs ?? []) if (!spec.file.endsWith("visual.spec.ts")) keys.push([spec.file, ...titles, spec.title].join(" › "));
      for (const child of suite.suites ?? []) visit(child, [...titles, child.title]);
    };
    report.suites.forEach(suite => visit(suite));
    return keys.sort();
  };
  try {
    const chromium = discover("chromium");
    assert.ok(chromium.length > 0);
    assert.deepEqual(discover("firefox"), chromium);
    for (const config of ["playwright.coldstart.config.ts", "playwright.live-renew.config.ts"])
      assert.ok(discover("firefox", config).length > 0, `${config} must retain its dedicated Firefox coverage`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("live shards reserve cleanup time and run auxiliary suites independently", () => {
  const workflow = yaml.load(read(".github/workflows/e2e-live.yml"));
  const dir = mkdtempSync(path.join(tmpdir(), "live-dispatch-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npx"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALLS"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, "node"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  try {
    for (const name of ["chromium", "firefox"]) {
      const job = workflow.jobs[name];
      const run = job.steps.find(step => step.run?.includes("e2e-live-report.mjs"));
      assert.ok(run["timeout-minutes"] <= 45, "test execution leaves setup and artifact headroom within the 60-minute job");
      assert.equal(job["timeout-minutes"], 60);
      assert.match(run.run, /--global-timeout=2400000/);
      assert.match(run.run, new RegExp(`--test-list="\\.cache/e2e-live-runtime/\\.cache/e2e-live-plan/${name}-\\$\\{SHARD\\}\\.txt"`));
      assert.ok(!run.run.includes('"$SHARD" == 1'), "auxiliary suites must not accumulate on shard 1");
      const suites = job.strategy.matrix.include.map(entry => entry.shard);
      assert.deepEqual(suites, name === "chromium"
        ? ["clock", "coldstart", "live-renew", "navigation", "focus-stress", "timeline"]
        : ["coldstart", "live-renew", "navigation", "focus-stress"]);
      assert.match(run.run, /--config="\$CONFIG"/);
      assert.equal(run.env.CONFIG, "${{ matrix.config || 'playwright.config.ts' }}");
      const project = name === "chromium" ? "parallel" : "firefox";
      for (const entry of [...job.strategy.matrix.shard.map(shard => ({ shard })), ...job.strategy.matrix.include]) {
        const calls = path.join(dir, "calls");
        const result = spawnSync("bash", ["-c", run.run], { cwd: dir, encoding: "utf8", env: { ...process.env,
          PATH: `${bin}:${process.env.PATH}`, CALLS: calls, SHARD: String(entry.shard),
          CONFIG: entry.config ?? "playwright.config.ts", PROJECT: entry.project ?? project } });
        assert.equal(result.status, 0, result.stdout + result.stderr);
        const args = readFileSync(calls, "utf8").trim().split("\n");
        assert.deepEqual(args, ["playwright", "test", ...(typeof entry.shard === "number"
          ? [`--project=${project}`, `--test-list=.cache/e2e-live-runtime/.cache/e2e-live-plan/${name}-${entry.shard}.txt`]
          : [`--config=${entry.config}`, "--no-deps", ...(entry.project ? [`--project=${entry.project}`] : [])]),
        "--global-timeout=2400000", "--retries=0", "--reporter=line,json"]);
      }
    }
    const focus = read("e2e/mock/focus-stress.config.ts");
    for (const spec of ["dept-head", "route-focus-title"])
      assert.ok(focus.includes(`"mock/${spec}.spec.ts"`), `${spec} must retain focus-stress coverage`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the workflow reaches every previously dormant Playwright surface", () => {
  const source = read(".github/workflows/e2e-live.yml");
  for (const file of [
    "playwright.coldstart.config.ts",
    "playwright.live-renew.config.ts",
    "playwright.navigation.config.ts",
    "e2e/mock/focus-stress.config.ts",
    "apps/web/src/ui/timeline-lanes/timeline-line.playwright.ts",
  ]) assert.ok(source.includes(file), file);
  assert.match(source, /--project=clock/);
});

test("the service image is the repository's pinned E2E Postgres image", () => {
  const compose = yaml.load(read("deploy/dev/compose.e2e.yml"));
  const workflow = yaml.load(read(".github/workflows/e2e-live.yml"));
  for (const name of ["chromium", "firefox"])
    assert.equal(workflow.jobs[name].services.postgres.image, compose.services.postgres.image);
});

test("route load runs only nightly or manually without delaying live E2E", () => {
  const live = yaml.load(read(".github/workflows/e2e-live.yml"));
  const workflow = yaml.load(read(".github/workflows/route-load.yml"));
  assert.deepEqual(Object.keys(workflow.on).sort(), ["schedule", "workflow_dispatch"]);
  assert.ok(workflow.on.schedule.length);
  assert.equal(live.jobs["route-load"], undefined);
  assert.equal(workflow.concurrency.group, "route-load-${{ github.ref }}");
  assert.notEqual(workflow.concurrency.group, live.concurrency.group);
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  const build = workflow.jobs.build;
  assert.ok(build.steps.some(step => step.run?.includes("cargo build --release --locked -p console-app --features full,e2e-test-support")));
  assert.ok(build.steps.some(step => step.run === "npm run build"));
  assert.ok(build.steps.some(step => step.with?.name === "e2e-live-runtime"));
});

test("route load publishes failed measurements against the served synthetic tenant", () => {
  const workflow = yaml.load(read(".github/workflows/route-load.yml"));
  const job = workflow.jobs["route-load"];
  assert.ok(job, "route-load needs a scheduled producer");
  assert.deepEqual(job.needs, ["build"]);
  assert.equal(job.env.E2E_SERVED, "1");
  assert.equal(job.env.E2E_PREBUILT, "1");
  assert.equal(job.env.E2E_PERF, "1");
  assert.equal(job.env.E2E_WORKERS, "1");
  const compose = yaml.load(read("deploy/dev/compose.e2e.yml"));
  assert.equal(job.services.postgres.image, compose.services.postgres.image);
  assert.ok(job.steps.some(step => step.uses?.startsWith("actions/download-artifact@") && step.with.name === "e2e-live-runtime"));
  const probe = job.steps.find(step => step.run?.includes("e2e/perf/route-load.spec.ts"));
  assert.match(probe.run, /--project=parallel/);
  assert.match(probe.run, /--retries=0/);
  assert.equal(probe.env.CONSOLE_DEV_POSTGRES_CONTAINER, "${{ job.services.postgres.id }}");
  const upload = job.steps.find(step => step.with?.name === "route-load-evidence");
  assert.equal(upload.if, "${{ always() }}");
  assert.equal(upload.with.path, "${{ runner.temp }}/route-load/route-load.json");
  assert.equal(upload.with["if-no-files-found"], "error");
  assert.equal(probe.env.PERF_EVIDENCE_DIR, "${{ runner.temp }}/route-load");
  assert.equal(job.env.PERF_EVIDENCE_DIR, undefined, "runner context is only available at step scope");
  assert.ok(!job.steps.some(step => step.run?.includes("cargo build")), "reuse the candidate binary");
});


test("Firefox mocked states run nightly in bounded shards without a backend", () => {
  const workflow = yaml.load(read(".github/workflows/e2e-live.yml"));
  const job = workflow.jobs["firefox-states"];
  assert.ok(job, "Firefox mocked states need a scheduled producer");
  assert.equal(job.if, "${{ github.event_name == 'schedule' }}");
  assert.deepEqual(job.needs, ["build"]);
  assert.deepEqual(job.strategy.matrix.shard, workflow.jobs.firefox.strategy.matrix.shard);
  assert.equal(job.strategy["max-parallel"], 4);
  assert.equal(job.services, undefined);
  assert.equal(job.env.E2E_XBROWSER, "1");
  assert.equal(job.env.E2E_WORKERS, "2");
  assert.ok(job.steps.some(step => step.run === "npx playwright install --with-deps firefox"));
  assert.ok(job.steps.some(step => step.with?.name === "e2e-live-runtime"));
  const discovery = workflow.jobs.build.steps.find(step => step.run?.includes("firefox-states-inventory.json"));
  assert.equal(discovery.if, job.if);
  assert.match(discovery.run, /E2E_XBROWSER=1 .*npx playwright test --config=e2e\/mock\/playwright.config.ts --list --reporter=json/);
  assert.match(discovery.run, /node scripts\/e2e-live-plan.mjs .cache\/e2e-live-plan\/firefox-states-inventory.json .cache\/e2e-live-plan firefox-states/);
  const run = job.steps.find(step => step.run?.includes("e2e-live-report.mjs"));
  assert.equal(job["timeout-minutes"], 60);
  assert.equal(run["timeout-minutes"], 45);
  assert.equal(run.env.SHARD, "${{ matrix.shard }}");
  const dir = mkdtempSync(path.join(tmpdir(), "states-dispatch-"));
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "npx"), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALLS"\nexit "${PW_STATUS:-0}"\n', { mode: 0o755 });
  writeFileSync(path.join(bin, "node"), '#!/bin/sh\nexit "${REPORT_STATUS:-0}"\n', { mode: 0o755 });
  try {
    for (const shard of job.strategy.matrix.shard) {
      const calls = path.join(dir, "calls");
      for (const [pw, report] of [[0, 0], [1, 0], [0, 1]]) {
        const result = spawnSync("bash", ["-c", run.run], { cwd: dir, encoding: "utf8", env: { ...process.env,
          PATH: `${bin}:${process.env.PATH}`, CALLS: calls, SHARD: String(shard), PW_STATUS: String(pw), REPORT_STATUS: String(report) } });
        assert.equal(result.status, pw || report, result.stdout + result.stderr);
        assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["playwright", "test",
          "--config=e2e/mock/playwright.config.ts", `--test-list=.cache/e2e-live-runtime/.cache/e2e-live-plan/firefox-states-${shard}.txt`,
          "--global-timeout=2400000", "--retries=0", "--reporter=line,json"]);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const upload = job.steps.find(step => step.with?.name === "e2e-live-firefox-states-${{ matrix.shard }}");
  assert.equal(upload.if, "${{ always() }}");
  assert.match(upload.with.path, /test-results-mock/);
  assert.equal(upload.with["if-no-files-found"], "error");
});


test("browser inventory discovery is opt-in and scheduled outside PR checks", () => {
  const workflow = yaml.load(read(".github/workflows/e2e-live.yml"));
  const inventory = workflow.jobs.build.steps.find(step => step.env?.E2E_LIVE_INVENTORY === "1");
  assert.ok(inventory, "the scheduled workflow must run the browser inventory check");
  assert.equal(inventory.if, "${{ github.event_name == 'schedule' }}");
  assert.match(inventory.run, /node --test .*scripts\/e2e-live-workflow.test.mjs/);
  assert.match(read("scripts/e2e-live-workflow.test.mjs"), /skip: !process.env.E2E_LIVE_INVENTORY/);
});

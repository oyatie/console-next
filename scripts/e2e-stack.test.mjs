// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import yaml from "js-yaml";

const root = process.env.CONSOLE_TEST_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(path.join(root, "scripts/backend-dev.mjs"), "utf8");
const files = [...source.matchAll(/"-f", "([^"]+)"/g)].map((m) => m[1]);

function stackFixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "compose-lifecycle-"));
  const state = path.join(dir, "state.json");
  const project = "fixture-stack";
  const other = "fixture-stack-neighbor";
  const network = `${project}_default`;
  writeFileSync(state, JSON.stringify({ networks: [`${other}_default`], calls: [], volume: "saved data" }));
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "bin/lsof"), `#!${process.execPath}
if (process.env.STACK_MODE === "image") {
  const { calls } = JSON.parse(require("node:fs").readFileSync(process.env.STACK_STATE, "utf8"));
  if (!calls.some(call => call.args.join(" ") === "rm --force fixture-stack-api")) {
    console.log("p42"); // A stale release container still holds the port.
    process.exit(0);
  }
}
process.exit(1);
`, { mode: 0o700 });
  writeFileSync(path.join(dir, "bin/docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "version") { console.log("28.0.4"); process.exit(0); }
if (args[0] === "compose" && args[1] === "version") { console.log("2.38.2"); process.exit(0); }
const state = JSON.parse(fs.readFileSync(process.env.STACK_STATE, "utf8"));
state.calls.push({ args, context: process.env.DOCKER_CONTEXT, role: process.env.CONSOLE_APP_ROLE });
let status = 0;
if (process.env.STACK_MODE === "image" && args[0] === "wait") console.log(27);
else if (process.env.STACK_MODE === "image" && args[0] === "logs") console.log("fixture API log");
else if (process.env.STACK_MODE === "image" && ["run", "rm"].includes(args[0])) status = 0;
else if (args[0] !== "compose" || args[args.indexOf("-p") + 1] !== process.env.CONSOLE_DEV_PROJECT) status = 99;
else if (args.includes("down")) {
  if (process.env.STACK_MODE === "down-failure" || process.env.STACK_MODE === "teardown-failure" && state.calls.filter(call => call.args.includes("down")).length > 1) status = 19;
  else {
    state.networks = state.networks.filter(name => name !== process.env.STACK_NETWORK);
    if (args.includes("-v")) state.volume = null;
  }
} else if (args.includes("up")) {
  state.staleAtStart = state.networks.includes(process.env.STACK_NETWORK);
  state.networks.push(process.env.STACK_NETWORK);
  if (process.env.STACK_MODE === "up-failure") status = 23;
} else if (args.includes("exec") && process.env.STACK_MODE === "bucket-failure") status = 24;
fs.writeFileSync(process.env.STACK_STATE, JSON.stringify(state));
process.exit(status);
`, { mode: 0o700 });
  writeFileSync(path.join(dir, "console-app"), `#!${process.execPath}
if (process.env.CONSOLE_APP_ROLE === "migrate") process.exit(process.env.STACK_MODE === "migration-failure" ? 25 : 0);
require("node:fs").writeFileSync(process.env.STACK_READY, "ready");
if (process.env.STACK_MODE === "hold") setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await child.closed;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const snapshot = () => JSON.parse(readFileSync(state, "utf8"));
  const start = (mode = "exit", args = [], env = {}) => {
    rmSync(path.join(dir, "ready"), { force: true });
    const child = spawn(process.execPath, [path.join(root, "scripts/backend-dev.mjs"), ...args], {
      env: {
        ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, DOCKER_CONTEXT: "fixture-context",
        CONSOLE_REPO: dir, CONSOLE_APP_BIN: path.join(dir, "console-app"), CONSOLE_DEV_PROJECT: project,
        E2E_CACHE_DIR: path.join(dir, "cache"), CONSOLE_EMAIL_STUB_MODE: "dev",
        STACK_STATE: state, STACK_NETWORK: network, STACK_READY: path.join(dir, "ready"), STACK_MODE: mode,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.output = "";
    for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { child.output += data; });
    child.closed = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code, signal) => resolve({ code, signal }));
    });
    children.push(child);
    return child;
  };
  const ready = async child => {
    const until = Date.now() + 10_000;
    while (!existsSync(path.join(dir, "ready"))) {
      assert.equal(child.exitCode, null, child.output);
      assert.ok(Date.now() < until, child.output);
      await delay(20);
    }
  };
  return {
    start, ready, snapshot, network, other,
    apiPid: () => JSON.parse(readFileSync(path.join(dir, "cache/backend.json"), "utf8")).apiPid,
    seedLeftover() {
      writeFileSync(state, JSON.stringify({ ...snapshot(), networks: [network, `${other}_default`] }));
    },
  };
}

for (const mode of ["exit", "up-failure", "bucket-failure", "migration-failure"])
  test(`Compose removes only its project's network after ${mode}`, { timeout: 15_000 }, async t => {
    const fixture = stackFixture(t);
    const child = fixture.start(mode);
    const result = await child.closed;
    assert.equal(result.code, mode === "exit" ? 0 : 1, child.output);
    const state = fixture.snapshot();
    assert.deepEqual(state.networks, [`${fixture.other}_default`]);
    assert.equal(state.volume, "saved data", "ordinary teardown preserves reuse data");
    assert.ok(state.calls.every(call => call.context === "fixture-context"));
  });

for (const signal of ["SIGINT", "SIGTERM"])
  test(`Compose removes its network on ${signal}`, { timeout: 15_000 }, async t => {
    const fixture = stackFixture(t);
    const child = fixture.start("hold");
    await fixture.ready(child);
    child.kill(signal);
    assert.equal((await child.closed).code, signal === "SIGINT" ? 130 : 143, child.output);
    assert.deepEqual(fixture.snapshot().networks, [`${fixture.other}_default`]);
  });

test("a slot clears its killed run's network before starting again without resetting its data", { timeout: 20_000 }, async t => {
  const fixture = stackFixture(t);
  const killed = fixture.start("hold");
  await fixture.ready(killed);
  const exited = new Promise(resolve => killed.once("exit", resolve));
  const apiPid = fixture.apiPid();
  killed.kill("SIGKILL");
  await exited;
  process.kill(-apiPid, "SIGKILL");
  assert.equal((await killed.closed).signal, "SIGKILL");
  assert.ok(fixture.snapshot().networks.includes(fixture.network));
  const next = fixture.start();
  assert.equal((await next.closed).code, 0, next.output);
  const state = fixture.snapshot();
  assert.equal(state.staleAtStart, false, "remove the interrupted project's network before compose up");
  assert.deepEqual(state.networks, [`${fixture.other}_default`]);
  assert.equal(state.volume, "saved data");
});

test("a failed project cleanup refuses to create another stack", { timeout: 15_000 }, async t => {
  const fixture = stackFixture(t);
  fixture.seedLeftover();
  const child = fixture.start("down-failure");
  assert.equal((await child.closed).code, 1, child.output);
  const state = fixture.snapshot();
  assert.ok(state.networks.includes(fixture.network));
  assert.ok(!state.calls.some(call => call.args.includes("up")));
});

test("a failed teardown reports failure instead of a successful run", { timeout: 15_000 }, async t => {
  const fixture = stackFixture(t);
  const child = fixture.start("teardown-failure");
  assert.equal((await child.closed).code, 1, child.output);
  assert.match(child.output, /compose teardown failed/);
});

test("Playwright's closed input tears down the stack", { timeout: 15_000 }, async t => {
  const fixture = stackFixture(t);
  const child = fixture.start("hold", [], { CONSOLE_EMAIL_STUB_MODE: "e2e", CONSOLE_SUPPORT_LOG_QUERY_URL: "http://127.0.0.1", CONSOLE_DEV_BACKEND_PORT: "0" });
  await fixture.ready(child);
  child.stdin.end();
  assert.equal((await child.closed).code, 1, child.output);
  assert.deepEqual(fixture.snapshot().networks, [`${fixture.other}_default`]);
});

test("an explicit reset still deletes the project's volumes", { timeout: 15_000 }, async t => {
  const fixture = stackFixture(t);
  const child = fixture.start("exit", ["--reset"]);
  assert.equal((await child.closed).code, 0, child.output);
  assert.equal(fixture.snapshot().volume, null);
  assert.deepEqual(fixture.snapshot().networks, [`${fixture.other}_default`]);
});

test("image smoke migrates and serves the selected image and reports an early API exit", async t => {
  const fixture = stackFixture(t);
  const image = "console-platform:fixture";
  const child = fixture.start("image", ["--reset", "--release-image"], {
    CONSOLE_RELEASE_IMAGE: image, CONSOLE_APP_BIN: "absent-binary", CONSOLE_DEV_BACKEND_PORT: "0",
  });
  assert.equal((await child.closed).code, 1);
  assert.match(child.output, /release API stopped \(exit 27\)/);
  const { calls, networks, volume } = fixture.snapshot();
  const runs = calls.filter(call => call.args[0] === "run");
  assert.deepEqual(runs.map(call => call.role), ["migrate", "api"]);
  for (const { args } of runs) {
    assert.equal(args.at(-1), image);
    assert.ok(args.includes("--pull=never") && args.includes("DATABASE_URL"));
    assert.ok(!args.includes("CONSOLE_WEB_DIST") && !args.includes("CONSOLE_EMAIL_STUB_MODE"));
  }
  assert.ok(runs[0].args.includes("--rm"));
  const api = runs[1].args;
  assert.ok(api.includes("--detach") && !api.includes("--rm"));
  assert.equal(api[api.indexOf("--name") + 1], "fixture-stack-api");
  assert.deepEqual(calls.filter(call => ["rm", "run", "wait", "logs"].includes(call.args[0]))
    .map(call => call.args[0] === "run" ? call.role : call.args.join(" ")), [
    "rm --force fixture-stack-api", "migrate", "api", "wait fixture-stack-api",
    "logs --tail 300 fixture-stack-api", "rm --force fixture-stack-api",
  ]);
  assert.match(child.output, /fixture API log/);
  assert.deepEqual(networks, [`${fixture.other}_default`]);
  assert.equal(volume, null);
});

for (const [engine, compose, fast] of [["29.5.2", "5.6.1", true], ["28.0.4", "2.38.2", true], ["24.0.9", "2.38.2", false], ["25.0.0", "2.20.1", false]])
  test(`launcher reports Engine ${engine} / Compose ${compose} and selects the supported health schedule`, t => {
    const dir = mkdtempSync(path.join(tmpdir(), "compose-health-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(path.join(dir, "bin"));
    writeFileSync(path.join(dir, "bin/lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    writeFileSync(path.join(dir, "bin/docker"), `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify({ args, context: process.env.DOCKER_CONTEXT }) + "\\n");
if (args[0] === "version") console.log(process.env.TEST_ENGINE);
else if (args[0] === "compose" && args[1] === "version") console.log(process.env.TEST_COMPOSE);
`, { mode: 0o700 });
    writeFileSync(path.join(dir, "console-app"), "#!/bin/sh\nexit 17\n", { mode: 0o700 });
    const result = spawnSync(process.execPath, [path.join(root, "scripts/backend-dev.mjs")], {
      encoding: "utf8", timeout: 30_000,
      env: {
        ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, DOCKER_CONTEXT: "fixture-context",
        DOCKER_LOG: path.join(dir, "docker.log"), TEST_ENGINE: engine, TEST_COMPOSE: compose,
        CONSOLE_REPO: dir, CONSOLE_APP_BIN: path.join(dir, "console-app"), CONSOLE_DEV_PROJECT: "fixture-health",
        CONSOLE_DEV_BACKEND_PORT: "0", E2E_CACHE_DIR: path.join(dir, "cache"),
      },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /migrations failed \(exit 17\)/, "the launcher waited for Compose before migrating");
    const calls = readFileSync(path.join(dir, "docker.log"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.find(call => call.args[0] === "version").args, ["version", "--format", "{{.Server.Version}}"]);
    assert.deepEqual(calls.find(call => call.args[0] === "compose" && call.args[1] === "version").args, ["compose", "version", "--short"]);
    assert.ok(calls.every(call => call.context === "fixture-context"));
    const up = calls.find(call => call.args.includes("up")).args;
    assert.ok(up.includes("--wait"));
    assert.equal(up.includes("deploy/dev/compose.startup.yml"), fast);
    assert.equal(result.stderr.includes("using 30s fallback"), !fast);
    assert.ok(result.stdout.includes(`Docker Engine ${engine}; Compose ${compose}`), result.stdout);
  });

test("test services probe quickly only during startup and detect failure within a minute", () => {
  const compose = yaml.load(readFileSync(path.join(root, "deploy/dev/compose.e2e.yml"), "utf8"));
  for (const [name, service] of Object.entries(compose.services)) {
    assert.equal(service.healthcheck.interval, "30s", name);
    assert.equal(service.healthcheck.timeout, "2s", name);
    assert.equal(service.healthcheck.retries, 1, name);
    assert.equal(service.healthcheck.start_period, "60s", name);
    const startup = yaml.load(readFileSync(path.join(root, "deploy/dev/compose.startup.yml"), "utf8"));
    assert.equal(startup.services[name].healthcheck.start_interval, "1s", name);
    assert.equal(service.healthcheck.start_interval, undefined, "base file remains compatible with older Compose");
  }
});

test("CI service healthchecks use startup probes and bounded steady-state detection", () => {
  let services = 0;
  for (const file of ["e2e-live", "route-load", "db-tests"]) {
    const { jobs } = yaml.load(readFileSync(path.join(root, `.github/workflows/${file}.yml`), "utf8"));
    for (const job of Object.values(jobs)) for (const service of Object.values(job.services ?? {})) {
      if (!service.options?.includes("--health-cmd")) continue;
      services++;
      const capabilities = job.steps.find(step => step.name === "Docker healthcheck capabilities");
      assert.match(capabilities?.run ?? "", /docker version\s+docker compose version/, file);
      for (const [flag, value] of Object.entries({ interval: "30s", timeout: "2s", retries: "1", "start-period": "60s", "start-interval": "1s" }))
        assert.match(service.options, new RegExp(`--health-${flag} ${value}(?:\\s|$)`), file);
    }
  }
  assert.equal(services, 4);
  assert.match(source, /compose\(\["up", "-d", "--wait"/);
});

test("startup interval negotiation keeps a safe fallback for older Docker and Compose", async () => {
  const { startupHealthcheckFiles } = await import(path.join(root, "scripts/compose-health.mjs"));
  for (const [engine, compose] of [["25.0.0", "2.20.2"], ["25.0.0", "v2.20.2-desktop.1"], ["25.0.0", "2.21.0"], ["28.0.4", "2.38.2"], ["29.5.2", "5.6.1"]])
    assert.deepEqual(startupHealthcheckFiles(engine, compose), ["-f", "deploy/dev/compose.startup.yml"]);
  for (const [engine, compose] of [["24.0.9", "2.38.2"], ["25.0.0", "2.20.1"], ["25.0.0", "2.19.9"], ["", "2.38.2"], ["25.0.0", ""]])
    assert.deepEqual(startupHealthcheckFiles(engine, compose), []);
  assert.match(source, /startupHealthcheckFiles/);
  assert.match(source, /\.\.\.startupFiles/);
});

test("the backend's compose files live in the public tree and contain only E2E services", () => {
  assert.ok(files.length, "backend-dev must declare its compose input");
  const services = [];
  for (const file of files) {
    assert.ok(!path.isAbsolute(file) && !file.split("/").includes(".."), file);
    assert.ok(existsSync(path.join(root, file)), `missing public compose file: ${file}`);
    const yaml = readFileSync(path.join(root, file), "utf8");
    const block = yaml.match(/^services:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m)?.[1];
    assert.ok(block, `${file}: missing services`);
    services.push(...[...block.matchAll(/^  ([a-z][a-z0-9-]*):/gm)].map((m) => m[1]));
    const images = [...yaml.matchAll(/^\s+image: (.+)$/gm)].map((m) => m[1]);
    assert.ok(images.length, `${file}: no images`);
    for (const image of images) assert.match(image, /^[\w./:-]+@sha256:[a-f0-9]{64}$/, `${file}: unpinned image`);
    for (const mount of yaml.matchAll(/^\s+- (\.\/[^:\n]+):/gm))
      assert.ok(existsSync(path.resolve(root, path.dirname(file), mount[1])), `${file}: missing bind mount ${mount[1]}`);
    for (const port of yaml.matchAll(/^\s+- ["']?([^\n]+):\d+["']?$/gm))
      assert.ok(port[1].startsWith("127.0.0.1:"), `${file}: published ports must be loopback-only`);
  }
  assert.deepEqual(services.sort(), ["postgres", "seaweedfs"]);
});

test("the launcher and Playwright resolve the backend from the public checkout", () => {
  assert.doesNotMatch(source, /backend-mvp|ops\/compose/);
  const config = readFileSync(path.join(root, "playwright.config.ts"), "utf8");
  assert.doesNotMatch(config, /backend-mvp/);
  assert.match(config, /gracefulShutdown: \{ signal: "SIGTERM", timeout: stackTimeout \}/);
  assert.match(config, /timeout: stackTimeout,\s+reuseExistingServer: reuse/);
});

test("Home CI runs the served scale probe with the selected release artifact", () => {
  const { jobs } = yaml.load(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));
  const home = jobs.home;
  assert.ok(home, "served Home must have its own required job");
  assert.match(home.if, /!cancelled\(\)/);
  assert.deepEqual(home.needs, ["affected", "backend-release"]);
  assert.equal(home["runs-on"], jobs["backend-release"]["runs-on"]);
  assert.deepEqual(home.permissions, { contents: "read" });
  assert.ok(home.steps[0].uses.startsWith("step-security/harden-runner@"));
  const build = jobs["backend-release"].steps.find(s => s.name === "Release backend for Home probe");
  assert.match(build.run, /cargo build .*--release.*e2e-test-support/);
  const upload = jobs["backend-release"].steps.find(s => s.with?.name === "d10-backend");
  assert.equal(upload.if, undefined, "candidate binary must be available on PRs and merge groups too");
  const download = home.steps.find(s => s.uses?.startsWith("actions/download-artifact@"));
  assert.equal(download.with.name, upload.with.name);
  assert.equal(download.with["run-id"], undefined);
  const probe = home.steps.find(s => s.name === "Served 2,000-person Home budget");
  assert.equal(probe.if, undefined);
  assert.match(probe.run, /home-inbox\.spec\.ts.*--project=parallel/);
  assert.equal(probe.env.E2E_SERVED, "1");
  assert.equal(probe.env.E2E_PREBUILT, "1");
  assert.equal(probe.env.CONSOLE_APP_BIN, `${download.with.path}/console-app`);
  assert.ok(home.steps.some(s => s.run === `chmod +x ${probe.env.CONSOLE_APP_BIN}`));
  assert.ok(home.steps.some(s => s.run?.includes("npm run build")));
  const report = home.steps.find(s => s.with?.name === "home-inbox-performance");
  assert.equal(report.if, "${{ always() }}");
  assert.equal(report.with.path, "test-results");
  assert.equal(report.with["if-no-files-found"], "error");
  assert.ok(jobs["ci-ok"].needs.includes("home"));
  assert.equal(jobs["ci-ok"].steps[0].env.NEEDS, "${{ toJSON(needs) }}");
  assert.deepEqual(jobs["release-evidence"].needs, ["affected"]);
  for (const name of ["Firefox for D7 solo journey", "Solo journey on Chromium and Firefox"]) {
    const step = home.steps.find(s => s.name === name);
    assert.equal(step.if, "${{ !cancelled() && github.event_name == 'merge_group' }}");
  }
  assert.equal(home.steps.find(s => s.name === "Solo journey on Chromium and Firefox").env.CONSOLE_APP_BIN, probe.env.CONSOLE_APP_BIN);
  assert.ok(home.steps.some(s => s.with?.name === "d7-playwright"));
  assert.ok(!jobs["backend-release"].steps.some(s => s.run?.includes("playwright test")));
});

test("WebKit PR coverage shares Home without adding a job or extending its timeout", () => {
  const { jobs } = yaml.load(readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8"));
  assert.equal(Object.keys(jobs).length, 16);
  const home = jobs.home;
  assert.equal(home["timeout-minutes"], 45);
  assert.match(home.if, /github.event_name != 'push'/);
  const install = home.steps.find(s => s.name === "WebKit for focused PR coverage");
  assert.equal(install?.if, "${{ !cancelled() }}");
  assert.equal(install?.run, "npx playwright install --with-deps webkit");
  for (const name of ["Focused WebKit states", "Solo journey on WebKit"]) {
    const step = home.steps.find(s => s.name === name);
    assert.ok(step, name);
    assert.equal(step.if, "${{ !cancelled() }}");
    assert.equal(step.env.E2E_BROWSER, "webkit");
    assert.match(step.run, /--grep @webkit-pr/);
    assert.ok(step.env.PLAYWRIGHT_JSON_OUTPUT_FILE.startsWith(".cache/webkit/"));
  }
  const live = home.steps.find(s => s.name === "Solo journey on WebKit");
  assert.equal(live.env.CONSOLE_APP_BIN, ".cache/home-backend/console-app");
  assert.equal(live.env.E2E_SERVED, "1");
  assert.equal(live.env.E2E_PREBUILT, "1");
  const report = home.steps.find(s => s.name === "WebKit results by spec");
  assert.equal(report?.if, "${{ !cancelled() }}");
  assert.match(report?.run, /node scripts\/e2e-live-report.mjs .cache\/webkit\/\*.json/);
  const artifact = home.steps.find(s => s.with?.name === "webkit-pr");
  assert.equal(artifact?.if, "${{ !cancelled() }}");
  assert.ok(artifact?.with["include-hidden-files"]);
});

test("the focused tag selects the same risk surfaces on all three engines", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "webkit-pr-inventory-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const browser of ["chromium", "firefox", "webkit"]) {
    for (const mock of [true, false]) {
      const output = path.join(directory, `${browser}-${mock}.json`);
      const env = { ...process.env, E2E_BROWSER: browser, PLAYWRIGHT_JSON_OUTPUT_FILE: output };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["node_modules/@playwright/test/cli.js", "test",
        ...(mock ? ["--config=e2e/mock/playwright.config.ts"] : ["e2e/first-run-solo.spec.ts"]), "--grep=@webkit-pr", "--list", "--reporter=json"], {
        cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
        env,
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const report = JSON.parse(readFileSync(output, "utf8"));
      assert.deepEqual(report.errors, []);
      const specs = [];
      const visit = suites => suites.forEach(suite => { specs.push(...(suite.specs ?? [])); visit(suite.suites ?? []); });
      visit(report.suites);
      const files = [...new Set(specs.map(s => s.file))].sort();
      assert.deepEqual(files, mock ? [
        "mock/account-picker.spec.ts", "mock/date-calendar.spec.ts", "mock/route-focus-title.spec.ts",
        "mock/session-stream.spec.ts", "mock/sheet-interactions.spec.ts", "mock/structure-inline-targets.spec.ts",
        "states/org-toolbar.spec.ts",
      ] : ["first-run-solo.spec.ts"]);
      assert.ok(specs.every(s => s.tags.includes("webkit-pr")));
      assert.ok(specs.every(s => s.tests.every(t => t.expectedStatus === "passed")), "the PR set must execute, not skip");
    }
  }
});

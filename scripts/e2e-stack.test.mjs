// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import yaml from "js-yaml";

const root = process.env.CONSOLE_TEST_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(path.join(root, "scripts/backend-dev.mjs"), "utf8");
const files = [...source.matchAll(/"-f", "([^"]+)"/g)].map((m) => m[1]);

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
  assert.doesNotMatch(readFileSync(path.join(root, "playwright.config.ts"), "utf8"), /backend-mvp/);
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

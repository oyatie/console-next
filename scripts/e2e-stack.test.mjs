// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import yaml from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = readFileSync(path.join(root, "scripts/backend-dev.mjs"), "utf8");
const files = [...source.matchAll(/"-f", "([^"]+)"/g)].map((m) => m[1]);

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

// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { load } from "js-yaml";
import { allowedEndpoints, endpointProblems, requiredEndpoints } from "./ci/egress.mjs";

const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const versions = () => JSON.parse(read("scripts/ci/versions.json"));
const workflows = () => readdirSync(new URL(".github/workflows/", root))
  .filter((file) => /\.ya?ml$/.test(file)).map((file) => [file, load(read(`.github/workflows/${file}`))]);
const missingEndpoints = (job) => endpointProblems(job).missing;

test("every block-mode job allows its step download endpoints, including redirects", () => {
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job.steps.some((step) => step.with?.["egress-policy"] === "block")) continue;
    assert.deepEqual(missingEndpoints(job), [], `${file}:${name}: missing egress endpoints`);
  }
});

test("endpoint controls reject each missing required endpoint and accept a network-free job", () => {
  assert.deepEqual(missingEndpoints({ steps: [{ uses: "step-security/harden-runner@pin", with: { "egress-policy": "block" } }, { run: "echo local" }] }), []);
  assert.deepEqual(missingEndpoints({ steps: [
    { with: { "egress-policy": "block", "allowed-endpoints": "github.com:443" } },
    { run: "bash scripts/ci/install-tools.sh actionlint\nnpm ci\ncurl https://download.example.invalid:8443/tool" },
  ] }).sort(), ["download.example.invalid:8443", "registry.npmjs.org:443", "release-assets.githubusercontent.com:443"]);
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job.steps.some((step) => step.with?.["egress-policy"] === "block")) continue;
    for (const endpoint of requiredEndpoints(job)) {
      const copy = structuredClone(job);
      copy.steps.find((step) => step.with?.["egress-policy"] === "block").with["allowed-endpoints"] =
        [...requiredEndpoints(job)].filter((value) => value !== endpoint).join(" ");
      assert.deepEqual(missingEndpoints(copy), [endpoint], `${file}:${name}: ${endpoint}`);
    }
  }
});

test("actionlint runs a checksum-pinned release binary in both lint jobs without Docker", () => {
  for (const [file, name] of [["ci.yml", "hygiene"], ["workflows-check.yml", "workflows"]]) {
    const job = load(read(`.github/workflows/${file}`)).jobs[name];
    const lint = job.steps.findIndex((step) => step.name === "actionlint");
    assert.match(job.steps[lint].run, /^actionlint -color$/);
    assert.ok(job.steps.slice(0, lint).some((step) => /install-tools\.sh[^\n]*\bactionlint\b/.test(step.run ?? "")));
    assert.doesNotMatch(JSON.stringify(job), /rhysd\/actionlint@|docker (?:run|pull)/);
    assert.equal(versions().actionlint.binary, "actionlint");
  }
});

test("hosted plan fixture refuses both missing checkout and implicit rustup endpoints", () => {
  const job = load(read("scripts/ci/fixtures/plan-egress-missing.yml")).jobs.plan;
  assert.deepEqual(missingEndpoints(job).sort(), ["github.com:443", "static.rust-lang.org:443"]);
  assert.deepEqual([...requiredEndpoints({ steps: [{ run: "node scripts/ci/plan.mjs" }] })], ["static.rust-lang.org:443"]);
});

test("block jobs have no unused endpoint allowances", () => {
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    const harden = job.steps.find((step) => step.with?.["egress-policy"] === "block");
    if (!harden) continue;
    const allowed = allowedEndpoints(job);
    assert.deepEqual(allowed.filter((entry) => !requiredEndpoints(job).has(entry)), [], `${file}:${name}: unused endpoints`);
  }
});

test("network tool map covers direct and indirect downloads independently of job allowances", () => {
  const endpoints = (run, env) => [...requiredEndpoints({ steps: [{ run, env }] })].sort();
  assert.deepEqual(endpoints("cargo metadata --no-deps --locked"), ["static.rust-lang.org:443"]);
  assert.deepEqual(endpoints("cargo fetch --locked"), ["index.crates.io:443", "static.crates.io:443", "static.rust-lang.org:443"]);
  assert.deepEqual(endpoints("node ../scripts/ci/rust-tests.mjs db 1"), ["static.rust-lang.org:443"]);
  assert.deepEqual(endpoints("node scripts/ci/rust-build.mjs"), ["index.crates.io:443", "static.crates.io:443", "static.rust-lang.org:443"]);
  assert.deepEqual(endpoints("npm ci --no-audit"), ["registry.npmjs.org:443"]);
  assert.deepEqual(endpoints("node scripts/ci/report.mjs", { CI_CACHE_TOTAL: "1" }), ["api.github.com:443"]);
  assert.deepEqual(endpoints("node scripts/ci/report.mjs"), []);
  assert.deepEqual(endpoints("sccache --show-stats"), []);
  assert.deepEqual(endpoints("playwright install --with-deps chromium"), ["archive.ubuntu.com:443", "azure.archive.ubuntu.com:80", "cdn.playwright.dev:443", "packages.microsoft.com:443", "playwright.download.prss.microsoft.com:443", "security.ubuntu.com:443", "storage.googleapis.com:443"]);
  assert.deepEqual(endpoints("node scripts/ci/e2e.mjs run"), ["auth.docker.io:443", "production.cloudflare.docker.com:443", "production.cloudfront.docker.com:443", "registry-1.docker.io:443"]);
  assert.deepEqual(endpoints("docker pull ghcr.io/example/image"), ["ghcr.io:443", "pkg-containers.githubusercontent.com:443"]);
  for (const tool of Object.keys(versions())) {
    assert.deepEqual(endpoints(`bash scripts/ci/install-tools.sh ${tool}`), ["github.com:443", "release-assets.githubusercontent.com:443"]);
  }
  assert.throws(() => requiredEndpoints({ steps: [{ uses: "actions/new-network-tool@pin" }] }), /unmapped network tool/);
});

test("block jobs reject unused allowances, broad wildcard substitutions and incompatible input separators", () => {
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job.steps.some((step) => step.with?.["egress-policy"] === "block")) continue;
    const copy = structuredClone(job);
    const input = copy.steps.find((step) => step.with?.["egress-policy"] === "block").with;
    input["allowed-endpoints"] = [...requiredEndpoints(copy), "unused.example.invalid:443"].join(" ");
    assert.deepEqual(endpointProblems(copy).unused, ["unused.example.invalid:443"], `${file}:${name}`);
    input["allowed-endpoints"] = "*.github.com:443";
    assert.deepEqual(endpointProblems(copy).unused, ["*.github.com:443"], `${file}:${name}`);
  }
  const job = { steps: [{ with: { "egress-policy": "block", "allowed-endpoints": "github.com:443\nstatic.rust-lang.org:443" } }] };
  assert.throws(() => allowedEndpoints(job), /invalid egress endpoint/);
  job.steps[0].with["allowed-endpoints"] = "github.com:443 \nstatic.rust-lang.org:443";
  assert.throws(() => allowedEndpoints(job), /invalid egress endpoint/);
});

test("hosted web-check follows npm scripts to reach's Cargo metadata invocation", () => {
  const job = load(read("scripts/ci/fixtures/web-check-egress-missing.yml")).jobs["web-check"];
  assert.deepEqual(missingEndpoints(job), ["static.rust-lang.org:443"]);
  assert.deepEqual([...requiredEndpoints({ steps: [{ run: "node scripts/check-reach.mjs" }] })], ["static.rust-lang.org:443"]);
});

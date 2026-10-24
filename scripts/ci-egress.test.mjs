// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { load } from "js-yaml";

const root = new URL("../", import.meta.url);
const read = (file) => readFileSync(new URL(file, root), "utf8");
const versions = () => JSON.parse(read("scripts/ci/versions.json"));
const workflows = () => readdirSync(new URL(".github/workflows/", root))
  .filter((file) => /\.ya?ml$/.test(file)).map((file) => [file, load(read(`.github/workflows/${file}`))]);
const releases = ["github.com:443", "release-assets.githubusercontent.com:443"];
const cargo = ["static.rust-lang.org:443", "index.crates.io:443", "static.crates.io:443", "crates.io:443"];
// Indirect downloads need contracts too: a URL-only scan misses registry/CDN redirects.
const docker = ["registry-1.docker.io:443", "auth.docker.io:443", "production.cloudflare.docker.com:443", "production.cloudfront.docker.com:443"];
const contracts = [
  [/actions\/checkout@/, ["github.com:443", "api.github.com:443", "codeload.github.com:443"]],
  [/actions\/setup-node@/, releases],
  [/actions\/(?:cache\/|upload-artifact@|download-artifact@)/, ["*.actions.githubusercontent.com:443", "*.blob.core.windows.net:443"]],
  [/github\/codeql-action\//, [...releases, "api.github.com:443", "uploads.github.com:443", "ghcr.io:443", "pkg-containers.githubusercontent.com:443"]],
  [/\bnpm ci\b/, ["registry.npmjs.org:443"]],
  [/\bcargo (?:fetch|build|clippy)\b|scripts\/ci\/rust-build\.mjs/, cargo],
  [/\bgh (?:api|run)\b/, ["api.github.com:443"]],
  [/\bdocker (?:run|pull)\b|scripts\/ci\/e2e\.mjs run/, docker],
  [/playwright install\b/, ["cdn.playwright.dev:443", "playwright.download.prss.microsoft.com:443", "storage.googleapis.com:443"]],
  [/playwright install\b[^\n]*--with-deps/, ["archive.ubuntu.com:80", "azure.archive.ubuntu.com:80", "security.ubuntu.com:80"]],
  [/notify-telegram\.sh send/, ["api.telegram.org:443"]],
];

function requiredEndpoints(job) {
  const required = new Set();
  for (const step of job.steps) {
    const command = `${step.uses ?? ""}\n${step.run ?? ""}`;
    for (const [pattern, endpoints] of contracts) if (pattern.test(command)) endpoints.forEach((endpoint) => required.add(endpoint));
    for (const [url] of command.matchAll(/https?:\/\/[a-z0-9.-]+(?::\d+)?/g)) {
      const parsed = new URL(url);
      required.add(`${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? 443 : 80)}`);
    }
    for (const [, tools] of command.matchAll(/scripts\/ci\/install-tools\.sh ([\w -]+)/g)) {
      for (const tool of tools.trim().split(/\s+/)) {
        const pin = versions()[tool];
        assert.ok(pin, `unconfigured release tool: ${tool}`);
        assert.match(pin.sha256, /^[a-f0-9]{64}$/);
        assert.ok(pin.url.includes(pin.version), `${tool}: unversioned download`);
        required.add(`${new URL(pin.url).hostname}:443`);
        releases.forEach((endpoint) => required.add(endpoint));
      }
    }
    if (step.env?.URL === "${{ secrets.PROBE_URL }}") required.add("${{ secrets.CONSOLE_PUBLIC_HOST }}:443");
    if (step.env?.CI_CACHE_TOTAL === "1") required.add("api.github.com:443");
  }
  return required;
}

function missingEndpoints(job) {
  const allowed = job.steps.find((step) => step.with?.["egress-policy"] === "block").with["allowed-endpoints"] ?? "";
  const entries = allowed.match(/\$\{\{[^}]+\}\}:\d+|[^\s]+/g) ?? [];
  return [...requiredEndpoints(job)].filter((endpoint) => !entries.some((entry) => entry === endpoint ||
    (entry.startsWith("*.") && endpoint.endsWith(entry.slice(1)))));
}

test("every block-mode job allows its step download endpoints, including redirects", () => {
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job.steps.some((step) => step.with?.["egress-policy"] === "block")) continue;
    assert.deepEqual(missingEndpoints(job), [], `${file}:${name}: missing egress endpoints`);
  }
});

test("endpoint controls reject each missing required endpoint and accept a network-free job", () => {
  assert.deepEqual(missingEndpoints({ steps: [{ with: { "egress-policy": "block" } }, { run: "echo local" }] }), []);
  assert.deepEqual(missingEndpoints({ steps: [
    { with: { "egress-policy": "block", "allowed-endpoints": "github.com:443" } },
    { run: "bash scripts/ci/install-tools.sh actionlint\nnpm ci\ncurl https://download.example.invalid:8443/tool" },
  ] }).sort(), ["download.example.invalid:8443", "registry.npmjs.org:443", "release-assets.githubusercontent.com:443"]);
  for (const [file, workflow] of workflows()) for (const [name, job] of Object.entries(workflow.jobs)) {
    if (!job.steps.some((step) => step.with?.["egress-policy"] === "block")) continue;
    for (const endpoint of requiredEndpoints(job)) {
      const copy = structuredClone(job);
      copy.steps.find((step) => step.with?.["egress-policy"] === "block").with["allowed-endpoints"] =
        [...requiredEndpoints(job)].filter((value) => value !== endpoint).join("\n");
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

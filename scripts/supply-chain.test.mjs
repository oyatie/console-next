// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { REQUIRED_SECURITY_JOBS } from "./check-workflow-hardening.mjs";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const workflow = yaml.load(read(".github/workflows/ci.yml"));
const security = () => {
  assert.ok(workflow.jobs["supply-chain"], "CI must run the supply-chain job");
  return workflow.jobs["supply-chain"];
};

for (const workspace of ["backend", "backend/fuzz", "apps/desktop/src-tauri"]) {
  test(`${workspace} resolves only patched zip versions`, () => {
    const versions = [...read(`${workspace}/Cargo.lock`).matchAll(/^name = "zip"\nversion = "([^"]+)"/gm)];
    assert.ok(versions.length, `${workspace} must retain its ZIP dependency`);
    for (const [, version] of versions) {
      const [major, minor, patch] = version.split(".").map(Number);
      assert.ok(major > 9 || (major === 9 && (minor > 0 || patch >= 5)), `${workspace}: vulnerable zip ${version}`);
    }
  });
}

test("npm check runs the register gate and its regression tests", () => {
  const command = JSON.parse(read("package.json")).scripts.check;
  assert.match(command, /node scripts\/check-deps\.mjs\s*&&/);
  assert.match(command, /node --test[^&]*scripts\/check-deps\.test\.mjs/);
  assert.match(command, /node --test[^&]*scripts\/supply-chain\.test\.mjs/);
});

test("npm decision register stores no copies of manifest requirements or resolved lock data", () => {
  const rows = JSON.parse(read("docs/quality/dependency-register.json")).rows.filter((r) => r.kind === "npm");
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const key of ["pins", "resolvedParents", "resolvedFootprint"]) assert.ok(!Object.hasOwn(row, key), `${row.name}: ${key}`);
    assert.ok(row.uses.every((use) => !Object.hasOwn(use, "requirement")), row.name);
    assert.ok(Object.hasOwn(row, "approval") && row.allowedLayers.length && row.license && row.reason, row.name);
  }
});

test("CI runs on pushes, pull requests and merge queue results", () => {
  for (const event of ["push", "pull_request", "merge_group"]) {
    assert.ok(Object.hasOwn(workflow.on, event), `CI must run on ${event}`);
  }
});

for (const [tool, variable] of [["cargo-deny", "CARGO_DENY_VERSION"], ["cargo-audit", "CARGO_AUDIT_VERSION"]]) {
  test(`${tool} installation uses its configured version pin`, () => {
    const install = security().steps.find((s) => s.name === "Install pinned tools on cache miss");
    assert.ok(install?.run.split("\n").some((line) => line.trim() === `cargo install ${tool} --locked --version "\${${variable}}" --root "$TOOL_ROOT"`), `${tool} must install the configured version`);
  });
}

test("Rust tools have explicit owner approval and matching generated architecture records", () => {
  const reviews = JSON.parse(read("scripts/quality/tooling-reviews.json"));
  const rows = JSON.parse(read("docs/quality/dependency-register.json")).rows;
  for (const name of ["cargo-deny", "cargo-audit"]) {
    const review = reviews[`ci-tool:${name}`];
    assert.equal(review?.class, "STANDARD");
    assert.deepEqual(review.approval, { by: "owner", on: "2026-10-27", ruling: "cargo deny and cargo audit approved." });
    const row = rows.find((r) => r.kind === "ci-tool" && r.name === name);
    assert.deepEqual(row?.approval, review.approval);
    assert.ok(read(review.architectureRecord).includes(`| \`ci-tool:${name}\` |`));
  }
});

test("pinned tools use trusted dev artifacts as a cache and never introduce a new action", () => {
  const job = security();
  assert.match(job.env.CARGO_DENY_VERSION, /^\d+\.\d+\.\d+$/);
  assert.match(job.env.CARGO_AUDIT_VERSION, /^\d+\.\d+\.\d+$/);
  assert.ok(job.steps.some((s) => s.run === "node --test scripts/supply-chain-fixtures.test.mjs"));
  const restore = job.steps.find((s) => s.uses?.startsWith("actions/download-artifact@"));
  const save = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(restore?.with["run-id"]);
  assert.match(save?.if, /github\.event_name == 'push'/);
  assert.match(save.if, /refs\/heads\/dev/);
  assert.match(JSON.stringify(job), /cargo-security-.*CARGO_DENY_VERSION.*CARGO_AUDIT_VERSION/);
  assert.match(JSON.stringify(job), /--locked --version/);
});

test("tool cache ignores expired artifacts and fork artifacts named dev", () => {
  const root = mkdtempSync(path.join(tmpdir(), "tool-cache-"));
  try {
    mkdirSync(path.join(root, "bin"));
    writeFileSync(path.join(root, "bin/curl"), '#!/bin/sh\nprintf "%s" "$ARTIFACTS"\n', { mode: 0o755 });
    const step = security().steps.find((s) => s.id === "cache");
    const artifact = (id, extra = {}) => ({ expired: false, workflow_run: { id, head_branch: "dev", repository_id: 1, head_repository_id: 1 }, ...extra });
    for (const artifacts of [[], [artifact(1, { expired: true })], [artifact(2, { workflow_run: { id: 2, head_branch: "dev", repository_id: 1, head_repository_id: 9 } })], [artifact(3)]]) {
      const output = path.join(root, "outputs");
      writeFileSync(output, "");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], { encoding: "utf8", env: {
        ...process.env, PATH: `${root}/bin:${process.env.PATH}`, RUNNER_TEMP: root,
        GITHUB_OUTPUT: output, GITHUB_ENV: path.join(root, "env"), CACHE_KEY: "pinned-tools", ARTIFACTS: JSON.stringify({ artifacts }),
      } });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8").includes("run-id=3"), artifacts[0]?.workflow_run.id === 3);
      assert.equal(readFileSync(output, "utf8").includes("run-id="), artifacts[0]?.workflow_run.id === 3);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("each Rust gate propagates a tool failure", () => {
  const job = security();
  const root = mkdtempSync(path.join(tmpdir(), "supply-chain-"));
  try {
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    for (const tool of ["cargo-deny", "cargo-audit"]) {
      writeFileSync(path.join(bin, tool), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\nexit "${TOOL_EXIT:-0}"\n', { mode: 0o755 });
      const step = job.steps.find((s) => s.name === tool);
      assert.ok(step, `${tool} must run without continue-on-error`);
      assert.ok(!step["continue-on-error"]);
      if (tool === "cargo-audit") assert.equal(step.if, "${{ !cancelled() }}");
      for (const status of [0, 19]) {
        const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], {
          encoding: "utf8", env: { ...process.env, RUNNER_TEMP: path.dirname(root), TOOL_ROOT: root, TOOL_EXIT: String(status), COMMAND_LOG: path.join(root, "calls") },
        });
        assert.equal(result.status, status, result.stderr);
      }
    }
    assert.match(readFileSync(path.join(root, "calls"), "utf8"), /--manifest-path backend\/Cargo.toml --locked check/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("affected paths uses full history, the event base and the checked-out merge commit", () => {
  const affected = workflow.jobs.affected;
  assert.ok(affected);
  assert.equal(affected.if, undefined);
  assert.deepEqual(affected.permissions, { contents: "read" });
  const checkout = affected.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, { "persist-credentials": false, "fetch-depth": 0 });
  assert.ok(affected.steps.some((s) => s.run === "node --test scripts/ci-affected.test.mjs"));
  const classify = affected.steps.find((s) => s.id === "paths");
  assert.deepEqual(classify.env, {
    BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
    HEAD_SHA: "${{ github.sha }}",
  });
  assert.equal(classify.run, 'node scripts/ci-affected.mjs "$GITHUB_EVENT_NAME" "$BASE_SHA" "$HEAD_SHA"');
  assert.deepEqual(affected.outputs, { backend: "${{ steps.paths.outputs.backend }}", web: "${{ steps.paths.outputs.web }}" });
  const existingUses = new Set(Object.entries(workflow.jobs).filter(([name]) => name !== "affected")
    .flatMap(([, job]) => (job.steps ?? []).map((s) => s.uses).filter(Boolean)));
  for (const step of affected.steps) if (step.uses) assert.ok(existingUses.has(step.uses));
});

test("ci-ok requires the affected-path aggregate and its regression controls", () => {
  assert.equal(workflow.jobs["ci-ok"].if, "${{ always() }}");
  assert.deepEqual([...workflow.jobs["ci-ok"].needs].sort(), ["affected", "backend", "backend-gates", "backend-release", "backend-tests", "commits", "home", "states", "states-plan", "states-timings", "supply-chain", "web"]);
  assert.ok(workflow.jobs.web.steps.some(s => s.run === "node --test scripts/ci-backend.test.mjs"));
});

test("Dependabot groups only minor and patch updates weekly on dev, leaving majors individual", () => {
  const config = yaml.load(read(".github/dependabot.yml"));
  assert.equal(config.version, 2);
  assert.deepEqual(config.updates.map((u) => u["package-ecosystem"]).sort(), ["cargo", "github-actions", "npm"]);
  for (const update of config.updates) {
    assert.equal(update.schedule.interval, "weekly");
    assert.equal(update["target-branch"], "dev");
    assert.deepEqual(Object.values(update.groups).map((g) => g.patterns), [["*"]]);
    for (const group of Object.values(update.groups)) assert.deepEqual(group["update-types"], ["minor", "patch"]);
    if (update["package-ecosystem"] === "github-actions") assert.equal(update.ignore, undefined);
  }
  assert.deepEqual(config.updates.find((u) => u["package-ecosystem"] === "cargo").directories.sort(), ["/apps/desktop/src-tauri", "/backend", "/backend/fuzz"]);
});

test("Dependabot defers all Apalis updates until the coordinated migration, leaving desktop patches eligible", () => {
  const source = read(".github/dependabot.yml");
  const config = yaml.load(source);
  const cargo = config.updates.find((u) => u["package-ecosystem"] === "cargo");
  assert.deepEqual(cargo.ignore, ["apalis", "apalis-postgres", "apalis-sql"].map((name) => ({
    "dependency-name": name,
  })));
  assert.match(source, /#.*docs\/quality\/dependencies\/dependabot-cargo-315\.md/);
});

test("Dependabot keeps Node declarations on the runtime major and defers native TypeScript", () => {
  const config = yaml.load(read(".github/dependabot.yml"));
  const npm = config.updates.find((u) => u["package-ecosystem"] === "npm");
  const nodeMajor = Number(read(".node-version").trim());
  assert.deepEqual(npm.ignore, [
    { "dependency-name": "@types/node", versions: [`>=${nodeMajor + 1}`] },
    { "dependency-name": "typescript", "update-types": ["version-update:semver-major"] },
  ]);
  assert.match(read(".github/dependabot.yml"), /#.*openapi-typescript.*JavaScript compiler API/);
  const manifest = JSON.parse(read("package.json"));
  const runtime = manifest.engines.node.match(/^>=(\d+)$/)?.[1];
  assert.ok(runtime, "Node runtime must have a major floor");
  assert.equal(Number(runtime), nodeMajor, "engines.node must match .node-version");
  const node = JSON.parse(read("docs/quality/dependency-register.json")).rows.find((r) => r.kind === "ci-tool" && r.name === "Node.js");
  assert.equal(node.uses[0].pin, manifest.engines.node);
  const typesMajor = Number(manifest.devDependencies["@types/node"].match(/^\^(\d+)\./)?.[1]);
  assert.ok(typesMajor <= nodeMajor, "Node declarations cannot exceed the runtime floor");
});

test("every CI Node setup uses the shared major pin and the build image records its upstream", () => {
  const major = read(".node-version").trim();
  assert.equal(major, "26");
  for (const file of readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((f) => /\.ya?ml$/.test(f))) {
    const config = yaml.load(read(`.github/workflows/${file}`));
    for (const [name, job] of Object.entries(config.jobs)) for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith("actions/setup-node@")) continue;
      assert.equal(step.with?.["node-version-file"], ".node-version", `${file}: ${name}`);
      assert.equal(step.with["node-version"], undefined, `${file}: ${name}`);
    }
  }
  const versions = JSON.parse(read("deploy/versions.json"));
  assert.match(versions.images.node, /^docker\.io\/library\/node@sha256:[a-f0-9]{64}$/);
  assert.match(versions.upstreamImages.node, new RegExp(`^docker\\.io/library/node:${major}\\.\\d+\\.\\d+-bookworm-slim$`));
});

test("Node image digest stays paired with the reviewed upstream tag", () => {
  const versions = JSON.parse(read("deploy/versions.json"));
  // Registry index and linux/amd64 + linux/arm64 NODE_VERSION verified together.
  assert.deepEqual([versions.upstreamImages.node, versions.images.node], [
    "docker.io/library/node:26.12.1-bookworm-slim",
    "docker.io/library/node@sha256:3041f464442defe6de36c20b6904b125a6178cfa0a7fc7cc99c0bb5120586f70",
  ]);
  const rows = JSON.parse(read("docs/quality/dependency-register.json")).rows;
  const node = rows.find((r) => r.kind === "container" && r.name === "docker.io/library/node");
  assert.equal(node.uses.find((u) => u.file === "deploy/versions.json").pin, versions.images.node);
});

test("security workflow templates use the shared Node major", () => {
  const pins = Object.values(REQUIRED_SECURITY_JOBS).flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith("actions/setup-node@"))
    .map((step) => step.with["node-version"]);
  assert.equal(pins.length, 2);
  assert.deepEqual(pins, [read(".node-version").trim(), read(".node-version").trim()]);
});

test("dependency/tool/image pin regeneration is current and refuses an unregistered image", () => {
  for (const [pins, status] of [["container:docker.io/library/node", 0], ["ci-tool:Node.js", 0], ["npm:qs", 0],
    ["npm:@axe-core/playwright", 0], ["npm:oxlint", 0], ["npm:@tanstack/react-query", 0], ["npm:lucide-react", 0],
    ["container:unregistered/image", 1]]) {
    const result = spawnSync(process.execPath, ["scripts/quality/generate-tooling-ledger.mjs", `--pins=${pins}`], { encoding: "utf8" });
    assert.equal(result.status, status, result.stdout + result.stderr);
    if (status) assert.match(result.stderr, /unregistered tool\/image: container:unregistered\/image/);
  }
});

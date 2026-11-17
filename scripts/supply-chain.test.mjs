// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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
  assert.match(save?.if, /github\.event_name == 'merge_group'/);
  assert.match(JSON.stringify(job), /cargo-security-.*CARGO_DENY_VERSION.*CARGO_AUDIT_VERSION/);
  assert.match(JSON.stringify(job), /--locked --version/);
});

test("tool cache takes the newest artifact of a successful CI push on dev's history and nothing else", async () => {
  const step = security().steps.find((s) => s.id === "cache");
  const runs = { 1: { event: "pull_request" }, 2: { conclusion: "failure" }, 3: { head_sha: "unmerged" }, 4: {}, 5: {} };
  let listed;
  const answer = (route) => {
    if (route === "actions/artifacts?name=pinned-tools&per_page=100") return { artifacts: listed };
    if (route === "branches/dev") return { commit: { sha: "tip" } };
    if (route.startsWith("compare/")) return { status: route.startsWith("compare/unmerged...") ? "diverged" : "ahead" };
    const id = route.match(/^actions\/runs\/(\d+)$/)?.[1];
    return id && { id: Number(id), path: ".github/workflows/ci.yml", event: "push", status: "completed", conclusion: "success",
      head_branch: "dev", head_sha: `sha${id}`, repository: { id: 1 }, head_repository: { id: 1 }, ...runs[id] };
  };
  const server = createServer((request, response) => {
    const body = request.headers.authorization === "Bearer test-token" && answer(request.url.replace("/repos/example/console/", ""));
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" }).end(JSON.stringify(body || {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(path.join(tmpdir(), "tool-cache-"));
  try {
    const artifact = (id, extra = {}) => ({ id, expired: false, created_at: new Date(id * 1000).toISOString(), workflow_run: { id, head_branch: "dev" }, ...extra });
    // A lookup the API refuses builds the tools rather than failing the gate.
    for (const [artifacts, expected, token = "test-token"] of [[[], ""], [[artifact(1), artifact(2), artifact(3), artifact(4, { expired: true })], ""],
      [[artifact(1), artifact(3), artifact(4), artifact(5, { expired: true })], "run-id=4\n"], [[artifact(4)], "", "other-token"]]) {
      listed = artifacts;
      const output = path.join(root, "outputs");
      writeFileSync(output, "");
      const { stdout } = await promisify(execFile)("bash", ["-e", "-o", "pipefail", "-c", step.run], { cwd: new URL("..", import.meta.url), env: {
        ...process.env, RUNNER_TEMP: root, GITHUB_OUTPUT: output, GITHUB_ENV: path.join(root, "env"), CACHE_KEY: "pinned-tools",
        GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: "example/console", GITHUB_REPOSITORY_ID: "1", GH_TOKEN: token,
      } });
      assert.equal(readFileSync(output, "utf8"), `key=pinned-tools\n${expected}`);
      assert.equal(stdout.includes("::warning::"), token !== "test-token");
    }
    // Only an explicit timing lookup takes a red run's artifact; every other run check still applies.
    listed = [artifact(1), artifact(2), artifact(3)];
    const output = path.join(root, "outputs");
    writeFileSync(output, "");
    await promisify(execFile)("node", [".github/ci-proof.cjs", "--any-conclusion", "pinned-tools", "ci.yml", "push"], { cwd: new URL("..", import.meta.url), env: {
      ...process.env, GITHUB_OUTPUT: output, GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, GITHUB_REPOSITORY: "example/console", GITHUB_REPOSITORY_ID: "1", GH_TOKEN: "test-token",
    } });
    assert.equal(readFileSync(output, "utf8"), "run-id=2\n");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("cached Rust tools run only when they match the digests recorded at build", () => {
  const job = security();
  const install = job.steps.find((s) => s.name === "Install pinned tools on cache miss");
  const verify = job.steps.find((s) => s.name === "Verify recorded tool digests");
  assert.ok(verify && !verify.if && !verify["continue-on-error"], "every run verifies before the gates execute the tools");
  assert.ok(job.steps.indexOf(verify) < job.steps.findIndex((s) => s.run === "node --test scripts/supply-chain-fixtures.test.mjs"), "the fixture proof runs the tools too");
  for (const upload of [job, workflow.jobs["dev-artifacts"]].map((j) => j.steps.find((s) => s.uses?.startsWith("actions/upload-artifact@") && s.with.path.includes("cargo-"))))
    assert.ok(path.matchesGlob("cargo-security.sha256", path.basename(upload.with.path)), `${upload.with.path} must carry the digest record`);
  const root = mkdtempSync(path.join(tmpdir(), "tool-digests-"));
  try {
    mkdirSync(path.join(root, "fake"));
    writeFileSync(path.join(root, "fake/cargo"), '#!/bin/sh\nfor root; do :; done\nmkdir -p "$root/bin"\nprintf "%s" "$2" > "$root/bin/$2"\n', { mode: 0o755 });
    const bin = path.join(root, "tools/bin");
    const run = (step) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], { encoding: "utf8", env: {
      ...process.env, PATH: `${root}/fake:${process.env.PATH}`, TOOL_ROOT: path.join(root, "tools"), CARGO_DENY_VERSION: "1", CARGO_AUDIT_VERSION: "1",
    } });
    assert.equal(run(install).status, 0);
    assert.equal(run(verify).status, 0, run(verify).stderr);
    writeFileSync(path.join(bin, "cargo-audit"), "changed");
    assert.notEqual(run(verify).status, 0);
    writeFileSync(path.join(bin, "cargo-audit"), "cargo-audit");
    assert.equal(run(verify).status, 0);
    const digests = path.join(bin, "cargo-security.sha256");
    writeFileSync(digests, readFileSync(digests, "utf8").split("\n")[0] + "\n");
    assert.notEqual(run(verify).status, 0, "a digest file must name both tools");
    rmSync(digests);
    assert.notEqual(run(verify).status, 0);
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
  assert.deepEqual(affected.permissions, { contents: "read", actions: "read" });
  const checkout = affected.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert.deepEqual(checkout.with, { "persist-credentials": false, "fetch-depth": 0 });
  assert.ok(affected.steps.some((s) => s.run === "node --test scripts/ci-affected.test.mjs"));
  const classify = affected.steps.find((s) => s.id === "paths");
  assert.deepEqual(classify.env, {
    BASE_SHA: "${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}",
    HEAD_SHA: "${{ github.sha }}",
  });
  assert.equal(classify.run, 'node scripts/ci-affected.mjs "$GITHUB_EVENT_NAME" "$BASE_SHA" "$HEAD_SHA"');
  assert.equal(affected.outputs.backend, "${{ steps.paths.outputs.backend || steps.import.outputs.backend }}");
  assert.equal(affected.outputs.web, "${{ steps.paths.outputs.web || steps.import.outputs.web }}");
  const existingUses = new Set(Object.entries(workflow.jobs).filter(([name]) => name !== "affected")
    .flatMap(([, job]) => (job.steps ?? []).map((s) => s.uses).filter(Boolean)));
  const admission = yaml.load(read(".github/workflows/release-admission.yml"));
  existingUses.add(admission.jobs.plan.steps.find(s => s.uses?.startsWith("actions/github-script@")).uses);
  for (const step of affected.steps) if (step.uses) assert.ok(existingUses.has(step.uses));
});

test("ci-ok requires the affected-path aggregate and its regression controls", () => {
  assert.equal(workflow.jobs["ci-ok"].if, "${{ always() }}");
  assert.deepEqual([...workflow.jobs["ci-ok"].needs].sort(), ["affected", "backend", "backend-cache", "backend-gates", "backend-release", "backend-tests", "dev-artifacts", "home", "release-evidence", "states", "states-plan", "states-timings", "supply-chain", "web", "workflows"]);
  assert.ok(workflow.jobs.web.steps.some(s => s.run?.includes("node --test scripts/ci-backend.test.mjs")));
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

for (const ecosystem of ["github-actions", "npm", "cargo"]) {
  test(`Dependabot ${ecosystem} lets new releases settle before version updates`, () => {
    const config = yaml.load(read(".github/dependabot.yml"));
    const update = config.updates.find((u) => u["package-ecosystem"] === ecosystem);
    assert.deepEqual(update.cooldown, { "default-days": 7 });
  });
}

test("Dependabot cooldown day values never fall below seven days", () => {
  const config = yaml.load(read(".github/dependabot.yml"));
  for (const update of config.updates) {
    for (const [key, days] of Object.entries(update.cooldown)) {
      if (key.endsWith("-days")) assert.ok(days >= 7, `${update["package-ecosystem"]}: ${key} must be at least seven days`);
    }
  }
});

test("Dependabot defers incompatible Cargo updates, leaving desktop patches eligible", () => {
  const source = read(".github/dependabot.yml");
  const config = yaml.load(source);
  const cargo = config.updates.find((u) => u["package-ecosystem"] === "cargo");
  assert.deepEqual(cargo.ignore, [
    { "dependency-name": "chacha20poly1305", versions: [">=0.11"] },
    { "dependency-name": "windows-registry", versions: [">=0.7"] },
    ...["apalis", "apalis-postgres", "apalis-sql"].map((name) => ({ "dependency-name": name })),
    ...["webauthn-rs", "webauthn-rs-proto", "webauthn-authenticator-rs"].map((name) => ({ "dependency-name": name, versions: ["0.6.*"] })),
    { "dependency-name": "atoi_simd", versions: [">=0.18"] },
  ]);
  assert.match(source, /#.*docs\/quality\/dependencies\/dependabot-cargo-315\.md/);
  assert.match(source, /#.*vendored calamine fork/);
});

test("Dependabot keeps runtime constraints and defers incompatible npm updates", () => {
  const config = yaml.load(read(".github/dependabot.yml"));
  const npm = config.updates.find((u) => u["package-ecosystem"] === "npm");
  const nodeMajor = Number(read(".node-version").trim());
  assert.deepEqual(npm.ignore, [
    { "dependency-name": "@types/node", versions: [`>=${nodeMajor + 1}`] },
    { "dependency-name": "typescript", "update-types": ["version-update:semver-major"] },
    { "dependency-name": "stylelint", versions: ["18.x"] },
    { "dependency-name": "oxlint", versions: ["1.91.x"] },
    { "dependency-name": "@tanstack/react-query", versions: [">=5.105.2"] },
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

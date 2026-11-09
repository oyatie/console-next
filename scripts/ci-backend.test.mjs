// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import yaml from "js-yaml";

const ci = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const backendJobs = ["backend", "backend-gates", "backend-tests", "backend-release"];

test("spreadsheet paste starts its own server after browser-backed unit tests", () => {
  const step = ci.jobs.web.steps.find(s => s.run?.includes("grid-table-paste.spec.ts"));
  assert.ok(step && !step.if && !step["continue-on-error"]);
  const port = Number(step.run.match(/CONSOLE_WEB_PORT=(\d+)/)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535);
  const config = readFileSync(new URL("../apps/web/src/features/people/ui/grid-table.playwright.ts", import.meta.url), "utf8");
  const defaultPort = Number(config.match(/CONSOLE_WEB_PORT \?\? (\d+)/)?.[1]);
  assert.ok(defaultPort > 0);
  assert.notEqual(port, defaultPort);
  assert.match(config, /env: \{ CONSOLE_WEB_PORT: String\(port\) \}/);
});

for (const name of backendJobs) test(`${name} runs for affected candidates or required push evidence`, () => {
  const job = ci.jobs[name];
  assert.ok(job, name);
  assert.deepEqual(job.needs, ["affected"]);
  assert.match(job.if, /!cancelled\(\)/);
  const condition = new Function("github", "needs", "cancelled", `return ${job.if.slice(3, -2)}`);
  for (const event of ["pull_request", "merge_group", "push"]) for (const affected of ["true", "false", ""]) for (const web of ["true", "false", ""]) {
    const expected = name === "backend-gates" ? event === "push" || affected === "true"
      : event !== "push" && (affected === "true" || name === "backend-release" && web === "true");
    assert.equal(condition({ event_name: event }, { affected: { outputs: { backend: affected, web } } }, () => false), expected);
  }
  assert.ok(job.steps[0].uses.startsWith("step-security/harden-runner@"));
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.ok(!job["continue-on-error"]);
  assert.ok(!job.steps.some(s => s.with?.cache === "npm"));
});

test("release policy CI evidence runs on every dev push and is required by ci-ok", t => {
  const policy = new URL("../deploy/gates.json", import.meta.url);
  if (!existsSync(policy)) return t.skip("Release policy is not present on this base");
  assert.ok(ci.on.push.branches.includes("dev"));
  const definitions = Object.values(JSON.parse(readFileSync(policy, "utf8")).checks).flat()
    .filter(definition => definition.workflow === "ci.yml");
  assert.ok(definitions.length > 0);
  for (const { job: name, step } of definitions) {
    const job = ci.jobs[name];
    assert.ok(job, name);
    assert.deepEqual(job.needs, ["affected"]);
    assert.ok(ci.jobs["ci-ok"].needs.includes(name), name);
    const condition = new Function("github", "needs", "cancelled", `return ${job.if.slice(3, -2)}`);
    for (const backend of ["true", "false", ""]) {
      assert.equal(condition({ event_name: "push" }, { affected: { outputs: { backend } } }, () => false), true, name);
    }
    if (step) assert.equal(job.steps.filter(s => s.name === step && !s.if && !s["continue-on-error"]).length, 1, step);
  }
});

test("Home uses a release artifact on every candidate; every Rust check stays required", () => {
  assert.deepEqual(ci.jobs.home.needs, ["affected", "backend-release"]);
  assert.equal(ci.jobs["d10-probes"], undefined);
  for (const name of backendJobs) assert.ok(ci.jobs["ci-ok"].needs.includes(name), name);
  assert.ok(ci.jobs.backend.steps.some(s => s.run === "cargo fmt --check"));
  assert.ok(ci.jobs.backend.steps.some(s => s.run === "cargo clippy --workspace --all-targets --locked -- -D warnings"));
  assert.ok(ci.jobs["backend-gates"].steps.some(s => s.run === "cargo test --locked -p console-gate-migration-safety"));
  assert.ok(ci.jobs["backend-release"].steps.some(s => s.run === "cargo build --release --locked -p console-app --features e2e-test-support"));
});

test("Home requires a successful same-run backend on every event and affected-path combination", () => {
  const home = ci.jobs.home, release = ci.jobs["backend-release"];
  const condition = job => new Function("github", "needs", "cancelled", `return ${job.if.slice(3, -2)}`);
  for (const event of ["pull_request", "merge_group", "push"]) for (const backend of ["true", "false", ""]) for (const web of ["true", "false", ""]) {
    const github = { event_name: event, sha: `${event}-candidate` };
    const needs = { affected: { result: "success", outputs: { backend, web } }, "backend-release": { result: "success" } };
    const required = event !== "push" && (backend === "true" || web === "true");
    assert.equal(condition(release)(github, needs, () => false), required, `${event}/${backend}/${web}: build`);
    for (const result of ["success", "skipped", "failure", "cancelled"]) for (const cancelled of [false, true]) {
      needs["backend-release"].result = result;
      assert.equal(condition(home)(github, needs, () => cancelled), required && result === "success" && !cancelled,
        `${event}/${backend}/${web}/${result}/${cancelled}: Home`);
      needs.affected.result = "failure";
      assert.equal(condition(home)(github, needs, () => cancelled), false);
      needs.affected.result = "success";
    }
    if (required) {
      // Checkout defaults to the run SHA; download-artifact defaults to the current run.
      const checkout = release.steps.find(s => s.uses?.startsWith("actions/checkout@"));
      assert.equal(checkout.with.ref ?? github.sha, github.sha);
      const download = home.steps.find(s => s.with?.name === "d10-backend");
      assert.equal(download.with["run-id"], undefined);
      assert.equal(download.with["github-token"], undefined);
      assert.equal(download.if, undefined);
      assert.ok(!download["continue-on-error"]);
      assert.equal(download.with.path, ".cache/home-backend");
    }
  }
  const probe = home.steps.find(s => s.run?.includes("e2e/performance/home-inbox.spec.ts"));
  assert.ok(probe && !probe.if && !probe["continue-on-error"]);
  assert.equal(probe.env.CONSOLE_APP_BIN, ".cache/home-backend/console-app");
});

test("ci-ok accepts only exact event/path skips and fails closed on missing classification", () => {
  const job = ci.jobs["ci-ok"], command = job.steps[0].run;
  assert.match(command, /^node <<'JS'\n[\s\S]*\nJS\n$/);
  const gate = new Script(command.slice("node <<'JS'\n".length, -3));
  const backendJobs = ["backend", "backend-gates", "backend-tests", "backend-release"];
  for (const event of ["pull_request", "merge_group", "push"]) for (const backend of ["true", "false"]) for (const web of ["true", "false"]) {
    const push = event === "push";
    const skips = new Set(push ? ["commits", "workflows", "web", "states-plan", "states", ...backendJobs.filter(name => name !== "backend-gates"), "home", "supply-chain"] : ["dev-artifacts"]);
    if (!push || web === "false") skips.add("states-timings");
    if (!push || backend === "false") skips.add("backend-cache");
    if (!push || backend === "false" && web === "false") skips.add("release-evidence");
    if (!push && backend === "false") backendJobs.filter(name => name !== "backend-release").forEach(name => skips.add(name));
    if (!push && backend === "false" && web === "false") skips.add("backend-release");
    if (!push && web === "false") ["web", "states-plan", "states"].forEach(name => skips.add(name));
    if (!push && backend === "false" && web === "false") skips.add("home");
    const needs = Object.fromEntries(job.needs.map(name => [name, { result: skips.has(name) ? "skipped" : "success" }]));
    needs.affected.outputs = { backend, web };
    const env = () => ({ NEEDS: JSON.stringify(needs), GITHUB_EVENT_NAME: event });
    const check = () => gate.runInNewContext({ process: { env: env() }, require: module => {
      assert.equal(module, "node:fs");
      return { mkdirSync() {}, writeFileSync() {} };
    } });
    assert.doesNotThrow(check);
    if (event === "pull_request" && backend === "true" && web === "true") {
      const shell = spawnSync("bash", ["-e", "-c", command], { encoding: "utf8", env: { ...process.env, ...env() } });
      assert.equal(shell.status, 0, shell.stderr);
    }
    for (const name of job.needs) {
      const expected = needs[name].result;
      for (const status of ["failure", "cancelled", expected === "success" ? "skipped" : "success"]) {
        needs[name].result = status;
        assert.throws(check, `${event}/${backend}/${web}/${name}/${status}`);
      }
      needs[name].result = expected;
    }
    for (const key of ["backend", "web"]) {
      delete needs.affected.outputs[key];
      assert.throws(check, /CI_CLASSIFICATION_MISSING/);
      needs.affected.outputs[key] = key === "backend" ? backend : web;
    }
  }
});

test("parallel builds restore the unchanged trusted cache and publish dev-only deltas to one writer", () => {
  const writer = ci.jobs["backend-cache"];
  assert.ok(writer);
  assert.match(writer.if, /github.event_name == 'push'/);
  const condition = new Function("github", "needs", `return ${writer.if}`);
  for (const event of ["pull_request", "merge_group", "push"]) for (const backend of ["true", "false", ""]) {
    assert.equal(condition({ event_name: event }, { affected: { outputs: { backend } } }), event === "push" && backend === "true");
  }
  assert.deepEqual(writer.needs, ["affected"]);
  const restore = writer.steps.find(s => s.id === "rust-cache");
  assert.match(restore.with.key, /^backend-.*runner.os.*runner.arch.*backend\/rust-toolchain.toml.*backend\/Cargo.lock.*backend\/\*\*\/Cargo.toml.*github.sha/);
  for (const name of backendJobs) {
    const job = ci.jobs[name];
    assert.deepEqual(job.steps.find(s => s.id === "rust-cache"), restore);
    assert.ok(!job.steps.some(s => s.uses?.startsWith("actions/cache/save@")));
    const delta = job.steps.find(s => s.name === "Collect Rust cache changes");
    assert.equal(delta?.if, "github.event_name == 'merge_group'");
    const artifact = job.steps.find(s => s.with?.name?.startsWith("rust-cache-"));
    assert.equal(artifact?.if, "github.event_name == 'merge_group'");
    assert.equal(artifact.with["if-no-files-found"], "error");
  }
  const save = writer.steps.find(s => s.uses?.startsWith("actions/cache/save@"));
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, "${{ steps.rust-cache.outputs.cache-primary-key }}");
});

test("Rust cache maintenance is non-fatal and bounded within job budgets", () => {
  for (const name of [...backendJobs, "backend-cache"]) {
    const job = ci.jobs[name];
    const maintenance = job.steps.filter(s => s.name === "Collect Rust cache changes" ||
      s.with?.name?.startsWith("rust-cache-") || s.with?.pattern === "rust-cache-*" ||
      s.name === "Merge Rust cache changes" || s.uses?.startsWith("actions/cache/save@"));
    assert.equal(maintenance.length, name === "backend-cache" ? 3 : 2);
    for (const step of maintenance) {
      assert.equal(step["continue-on-error"], true, `${name}: cache failures must not fail tests`);
      assert.ok(Number.isInteger(step["timeout-minutes"]) && step["timeout-minutes"] > 0);
    }
    const cacheMinutes = maintenance.reduce((sum, s) => sum + s["timeout-minutes"], 0);
    assert.ok(cacheMinutes < job["timeout-minutes"], `${name}: cache must fit inside job timeout`);
    if (name === "backend-tests") {
      // Measured tests take 25 minutes; leave setup and teardown headroom too.
      assert.ok(job["timeout-minutes"] >= 25 + cacheMinutes + 5);
    }
  }
});

for (const archives of ["none", "registry", "target"]) test(`cache merge tolerates missing archives: ${archives}`, () => {
  const merge = ci.jobs["backend-cache"].steps.find(s => s.name === "Merge Rust cache changes");
  const root = mkdtempSync(path.join(tmpdir(), "rust-cache-missing-"));
  try {
    const home = path.join(root, "home"), workspace = path.join(root, "workspace");
    mkdirSync(home); mkdirSync(workspace);
    const env = { ...process.env, HOME: home, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: root };
    if (archives !== "none") {
      mkdirSync(path.join(root, "rust-cache"));
      writeFileSync(path.join(root, "entry"), "cached");
      const archive = spawnSync("tar", ["-czf", path.join(root, `rust-cache/${archives}-test.tgz`), "-C", root, "entry"], { encoding: "utf8" });
      assert.equal(archive.status, 0, archive.stderr);
    }
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", merge.run], { env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    if (archives !== "none") assert.equal(readFileSync(path.join(archives === "registry" ? home : workspace, "entry"), "utf8"), "cached");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

for (const archive of ["registry", "target"]) test(`cache collection publishes only complete archives when ${archive} compression fails`, () => {
  const job = ci.jobs.backend;
  const root = mkdtempSync(path.join(tmpdir(), "rust-cache-interrupted-"));
  try {
    const home = path.join(root, "home"), workspace = path.join(root, "workspace"), bin = path.join(root, "bin");
    mkdirSync(home); mkdirSync(workspace); mkdirSync(bin);
    const env = { ...process.env, HOME: home, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: root, GITHUB_JOB: "backend", FAIL_ARCHIVE: archive, PATH: `${bin}:${process.env.PATH}` };
    const run = command => spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], { env, encoding: "utf8" });
    assert.equal(run(job.steps.find(s => s.name === "Mark restored cache").run).status, 0);
    writeFileSync(path.join(bin, "tar"), '#!/bin/bash\ncat >/dev/null\nprintf partial > "$3"\ncase "$3" in */"$FAIL_ARCHIVE"-*) exit 1 ;; esac\n', { mode: 0o755 });
    const result = run(job.steps.find(s => s.name === "Collect Rust cache changes").run);
    assert.notEqual(result.status, 0);
    const uploaded = spawnSync("bash", ["-c", 'find "$RUNNER_TEMP/rust-cache" -name "*.tgz" -print'], { env, encoding: "utf8" });
    assert.equal(uploaded.status, 0, uploaded.stderr);
    assert.equal(uploaded.stdout, archive === "registry" ? "" : `${root}/rust-cache/registry-backend-0.tgz\n`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cache deltas retain new files and permissions without republishing restored files", () => {
  const job = ci.jobs["backend-release"];
  const prepare = job?.steps.find(s => s.name === "Mark restored cache");
  const collect = job?.steps.find(s => s.name === "Collect Rust cache changes");
  const merge = ci.jobs["backend-cache"]?.steps.find(s => s.name === "Merge Rust cache changes");
  assert.ok(prepare && collect && merge);
  const root = mkdtempSync(path.join(tmpdir(), "rust-cache-test-"));
  try {
    const home = path.join(root, "home"), workspace = path.join(root, "workspace");
    mkdirSync(home); mkdirSync(workspace);
    const env = { ...process.env, HOME: home, GITHUB_WORKSPACE: workspace, RUNNER_TEMP: root, GITHUB_JOB: "backend-release" };
    const run = command => {
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], { cwd: workspace, env, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    run(prepare.run);
    const marker = path.join(root, "rust-cache-start");
    utimesSync(marker, new Date(2000), new Date(2000));
    writeFileSync(path.join(home, ".cargo/registry/cache/new"), "registry");
    // cargo unpacks sources with the crate's own old mtimes but writes a fresh .cargo-ok marker
    const unpacked = path.join(home, ".cargo/registry/src/crate-1.0.0");
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(path.join(unpacked, ".cargo-ok"), "ok");
    writeFileSync(path.join(workspace, "backend/target/new"), "executable", { mode: 0o755 });
    const old = path.join(workspace, "backend/target/old");
    writeFileSync(old, "restored"); utimesSync(old, new Date(1000), new Date(1000));
    const oldRegistry = path.join(home, ".cargo/registry/cache/old");
    writeFileSync(oldRegistry, "restored"); utimesSync(oldRegistry, new Date(1000), new Date(1000));
    run(collect.run);
    rmSync(path.join(home, ".cargo"), { recursive: true });
    rmSync(path.join(workspace, "backend/target"), { recursive: true });
    run(merge.run);
    assert.equal(readFileSync(path.join(home, ".cargo/registry/cache/new"), "utf8"), "registry");
    assert.throws(() => readFileSync(path.join(unpacked, ".cargo-ok")), /ENOENT/, "a src marker without its sources poisons the cache");
    assert.equal(readFileSync(path.join(workspace, "backend/target/new"), "utf8"), "executable");
    assert.equal(statSync(path.join(workspace, "backend/target/new")).mode & 0o777, 0o755);
    assert.throws(() => readFileSync(old), /ENOENT/);
    assert.throws(() => readFileSync(oldRegistry), /ENOENT/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nextest shards compile disjoint integration targets and cover every workspace target", async () => {
  const { buildTargets } = await import("./backend-tests.mjs");
  const metadata = { workspace_members: ["a", "b"], packages: [
    { id: "a", targets: [{ name: "alpha", kind: ["test"] }, { name: "same", kind: ["test"] }, { name: "lib", kind: ["lib"] }] },
    { id: "b", targets: [{ name: "beta", kind: ["test"] }, { name: "same", kind: ["test"] }, { name: "disabled", kind: ["test"], test: false }] },
    { id: "external", targets: [{ name: "external", kind: ["test"] }] },
  ] };
  assert.deepEqual(buildTargets(metadata, 1, 2), ["--workspace", "--lib", "--bins", "--test", "alpha", "--test", "same"]);
  assert.deepEqual(buildTargets(metadata, 2, 2), ["--workspace", "--test", "beta"]);
  assert.deepEqual(buildTargets(metadata, undefined, undefined), ["--workspace"]);
  for (const args of [[0, 2], [3, 2], [1, 0], [1, undefined], [1, 4], [1.5, 2]]) assert.throws(() => buildTargets(metadata, ...args));
  const unsupported = structuredClone(metadata);
  unsupported.packages[0].targets.push({ name: "example", kind: ["example"], test: true });
  assert.throws(() => buildTargets(unsupported, 1, 2), /unsupported nextest test target/);
  const shards = ci.jobs["backend-tests"].strategy.matrix.shard;
  assert.equal(ci.jobs["backend-tests"].strategy["fail-fast"], false);
  assert.deepEqual(shards, Array.from({ length: shards.length }, (_, i) => i + 1));
  assert.ok(shards.length > 1);
  assert.equal(ci.jobs["backend-tests"].env.NEXTEST_SHARD, "${{ matrix.shard }}");
  assert.equal(ci.jobs["backend-tests"].env.NEXTEST_SHARDS, "${{ strategy.job-total }}");
});

test("shard targets respect Cargo's resolved required features", async () => {
  const { buildTargets } = await import("./backend-tests.mjs");
  const metadata = { workspace_members: ["app"], packages: [{ id: "app", targets: [
    { name: "ordinary", kind: ["test"] },
    { name: "attendance", kind: ["test"], "required-features": ["attendance"] },
    { name: "action_inbox_api", kind: ["test"], "required-features": ["full"] },
    { name: "mixed", kind: ["test"], "required-features": ["attendance", "full"] },
  ] }], resolve: { nodes: [{ id: "app", features: ["default", "mvp", "attendance"] }] } };
  assert.deepEqual(buildTargets(metadata, 1, 2), ["--workspace", "--lib", "--bins", "--test", "attendance"]);
  assert.deepEqual(buildTargets(metadata, 2, 2), ["--workspace", "--test", "ordinary"]);
  assert.throws(() => buildTargets({ ...metadata, resolve: null }, 1, 2), /missing resolved features/);
  metadata.packages.push({ id: "other", targets: [{ name: "ordinary", kind: ["test"], "required-features": ["full"] }] });
  metadata.workspace_members.push("other");
  metadata.resolve.nodes.push({ id: "other", features: [] });
  assert.throws(() => buildTargets(metadata, 1, 2), /ambiguous feature-gated test target/);
});

test("PR fan-out stays below the runner allowance across workflows", () => {
  const shards = ci.jobs["backend-tests"].strategy.matrix.shard;
  const timings = JSON.parse(readFileSync(new URL("../e2e/mock/timings.json", import.meta.url)));
  assert.ok(shards.length <= 2);
  assert.ok(timings.maxShards <= 5);
  assert.ok(timings.budgetSeconds <= 600);
  // Long root jobs can overlap later jobs; count every dependency-independent combination.
  let concurrent = 0;
  for (const file of ["ci.yml", "codeql.yml", "platform.yml", "workflows-check.yml"]) {
    const workflow = yaml.load(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
    if (!Object.hasOwn(workflow.on, "pull_request")) continue;
    const ancestors = name => [workflow.jobs[name].needs ?? []].flat().flatMap(n => [n, ...ancestors(n)]);
    const nodes = [];
    for (const [name, job] of Object.entries(workflow.jobs)) {
      if (job.if?.includes("github.ref == 'refs/heads/dev'") || /^github.event_name == 'push'/.test(job.if ?? "")) continue;
      const matrix = job.strategy?.matrix;
      const width = values => typeof values === "string"
        ? new Function("github", "fromJSON", `return ${values.slice(3, -2)}`)({ event_name: "pull_request" }, JSON.parse).length : values.length;
      const count = name === "states" ? timings.maxShards : !matrix ? 1 : matrix.include?.length ?? Object.values(matrix).reduce((n, values) => n * width(values), 1);
      nodes.push({ name, count, ancestors: new Set(ancestors(name)) });
    }
    let widest = 0;
    for (let mask = 1; mask < 2 ** nodes.length; mask++) {
      const active = nodes.filter((_, i) => mask & (1 << i));
      if (active.every(node => active.every(other => !node.ancestors.has(other.name))))
        widest = Math.max(widest, active.reduce((sum, node) => sum + node.count, 0));
    }
    concurrent += widest;
  }
  assert.ok(concurrent <= 20, `${concurrent} concurrent PR jobs exceeds the runner allowance`);
});

test("push consumers import queue reports and caches without promoting backend binaries", () => {
  for (const name of ["states-timings", "backend-cache", "release-evidence"]) {
    const job = ci.jobs[name];
    assert.deepEqual(job.needs, ["affected"]);
    assert.match(job.if, /github.event_name == 'push'/);
    for (const download of job.steps.filter(s => s.uses?.startsWith("actions/download-artifact@"))) {
      assert.equal(download.with["run-id"], "${{ needs.affected.outputs.run-id }}");
      assert.equal(download.with["github-token"], "${{ github.token }}");
    }
  }
  const dev = ci.jobs["dev-artifacts"];
  assert.deepEqual(dev.needs, ["affected"]);
  assert.ok(!dev.steps.some(s => s.with?.name === "d10-backend"));
  assert.ok(dev.steps.some(s => s.uses?.startsWith("actions/cache/save@")));
  assert.ok(dev.steps.some(s => s.with?.name === "${{ needs.affected.outputs.tools }}"));
  assert.equal(ci.jobs.commits.if, "github.event_name != 'push'");
  assert.equal(ci.jobs["supply-chain"].if, "github.event_name != 'push'");
  assert.ok(ci.jobs["ci-ok"].steps.some(s => s.with?.name === "ci-proof"));
  const admission = JSON.parse(readFileSync(new URL("../.github/release-admission-policy.json", import.meta.url)));
  assert.equal(admission.push_ci.workflow, "ci.yml");
});

test("web and state jobs run only for affected candidates, never dev pushes", () => {
  for (const name of ["web", "states-plan"]) {
    const job = ci.jobs[name];
    assert.deepEqual(job.needs, ["affected"]);
    const condition = new Function("github", "needs", `return ${job.if.slice(3, -2)}`);
    for (const event of ["pull_request", "merge_group", "push"]) for (const web of ["true", "false", ""]) {
      assert.equal(condition({ event_name: event }, { affected: { outputs: { web } } }), event !== "push" && web === "true");
    }
  }
});

test("push proof accepts only a successful trusted queue run with the same tree and base ancestry", async () => {
  const { source } = await import("../.github/ci-proof.cjs");
  const context = { repo: { owner: "sample", repo: "console" }, sha: "merged", payload: { before: "base", repository: { id: 42 } } };
  const good = { id: 10, path: ".github/workflows/ci.yml", event: "merge_group", status: "completed", conclusion: "success", head_branch: "gh-readonly-queue/dev/pr-1", head_sha: "queue", repository: { id: 42 }, head_repository: { id: 42 } };
  const api = (runs, tree = "tree", ancestor = "base") => ({
    paginate: Object.assign(async () => [{ name: "cargo-security-Linux-X64-deny-1-audit-1" }], {
      iterator: async function* (route, args) { assert.equal(args.event, "merge_group"); assert.equal(args.head_sha, context.sha); yield { data: runs }; },
    }),
    rest: { repos: {
      getCommit: async ({ ref }) => ({ data: { commit: { tree: { sha: ref === "merged" ? "tree" : tree } } } }),
      compareCommits: async () => ({ data: { merge_base_commit: { sha: ancestor } } }),
    } },
  });
  assert.deepEqual(await source(api([good]), context), { id: 10, sha: "queue", tools: "cargo-security-Linux-X64-deny-1-audit-1" });
  for (const patch of [{ event: "push" }, { status: "in_progress" }, { conclusion: "failure" }, { head_branch: "feature" }, { path: "other.yml" }, { repository: { id: 99 } }, { head_repository: { id: 99 } }]) {
    await assert.rejects(source(api([{ ...good, ...patch }]), context), /CI_PROOF_MISSING/);
  }
  await assert.rejects(source(api([good], "wrong"), context), /CI_PROOF_MISSING/);
  await assert.rejects(source(api([good], "tree", "other-base"), context), /CI_PROOF_MISSING/);
  await assert.rejects(source(api([]), context), /CI_PROOF_MISSING/);
  const expired = api([good]);
  expired.paginate = Object.assign(async () => [{ name: "cargo-security-old", expired: true }], { iterator: expired.paginate.iterator });
  await assert.rejects(source(expired, context), /CI_PROOF_TOOLS/);
});


test("duplicate browser, compiler and workflow checks retain a merge-gating copy", () => {
  const read = file => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const live = yaml.load(read(".github/workflows/e2e-live.yml"));
  const inventory = live.jobs.build.steps.find(s => s.name === "Refuse an empty live suite").run;
  for (const name of ["chromium", "firefox"]) {
    const excluded = name === "chromium" ? "first-run-solo|authz/write-refusals|error-beacon" : "first-run-solo";
    const command = inventory.split("\n").find(line => line.includes(`${name}-inventory.json`));
    assert.ok(command.includes(`--grep-invert='${excluded}'`));
    assert.match(command, /--list/);
    assert.ok(!live.jobs[name].strategy.matrix.include.some(entry => entry.shard === "grid"));
  }
  const probes = ci.jobs.home.steps.find(s => s.run?.includes("authz/write-refusals.spec.ts"));
  assert.equal(probes.if, "github.event_name == 'merge_group'");
  assert.ok(ci.jobs.home.steps.some(s => s.run?.includes("e2e/error-beacon.spec.ts")));
  assert.ok(ci.jobs["ci-ok"].needs.includes("home"));
  const pkg = JSON.parse(read("package.json"));
  assert.doesNotMatch(pkg.scripts.check, /npm run typecheck/);
  assert.match(pkg.scripts.build, /^tsc /);
  assert.match(pkg.scripts.check, /npm run build/);
  const lint = yaml.load(read(".github/workflows/workflows-check.yml"));
  assert.deepEqual(Object.keys(lint.on), ["workflow_call"]);
  assert.equal(ci.jobs.workflows.uses, "./.github/workflows/workflows-check.yml");
  assert.ok(ci.jobs["ci-ok"].needs.includes("workflows"));
  assert.equal(lint.on.push, undefined);
  const platform = yaml.load(read(".github/workflows/platform.yml"));
  for (const job of Object.values(platform.jobs)) for (const step of job.steps ?? [])
    assert.doesNotMatch(step.run ?? "", /(?:^|[;&|])\s*(?:npx\s+)?actionlint(?:\s|$)/m);
});

test("imported classifications refuse a mismatched commit or missing affected output", () => {
  const step = ci.jobs.affected.steps.find(s => s.id === "import");
  const dir = mkdtempSync(path.join(tmpdir(), "ci-proof-import-"));
  try {
    mkdirSync(path.join(dir, ".cache/proof"), { recursive: true });
    const proof = { commit: "queue", jobs: { affected: { outputs: { backend: "false", web: "true" } } } };
    const run = () => {
      writeFileSync(path.join(dir, ".cache/proof/ci.json"), JSON.stringify(proof));
      return spawnSync("bash", ["-e", "-c", step.run], { cwd: dir, encoding: "utf8", env: {
        ...process.env, PROVEN_SHA: "queue", GITHUB_OUTPUT: path.join(dir, "output"),
      } });
    };
    assert.equal(run().status, 0);
    proof.commit = "other";
    assert.match(run().stderr, /CI_PROOF_COMMIT/);
    proof.commit = "queue";
    delete proof.jobs.affected.outputs.web;
    assert.match(run().stderr, /CI_PROOF_CLASSIFICATION/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("push proof tolerates run-completion lag and refuses persistent absence or API errors", async () => {
  const script = ci.jobs.affected.steps.find(s => s.id === "proof").with.script;
  const run = (source) => new (Object.getPrototypeOf(async function() {}).constructor)("require", "github", "context", "setTimeout", script)(
    () => ({ source }), {}, {}, resolve => resolve());
  let attempts = 0;
  assert.equal(await run(async () => {
    if (++attempts === 1) throw new Error("CI_PROOF_MISSING");
    return 12;
  }), 12);
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(run(async () => { attempts++; throw new Error("CI_PROOF_MISSING"); }), /CI_PROOF_MISSING/);
  assert.equal(attempts, 6);
  attempts = 0;
  await assert.rejects(run(async () => { attempts++; throw new Error("HTTP 403"); }), /HTTP 403/);
  assert.equal(attempts, 1);
});


test("a stacked web-only queue entry builds its own backend after an earlier backend entry", async t => {
  const { classifyPaths } = await import("./ci-affected.mjs");
  const root = mkdtempSync(path.join(tmpdir(), "stacked-queue-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: "Jason Lee", GIT_AUTHOR_EMAIL: "56489493+jason931225@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Jason Lee", GIT_COMMITTER_EMAIL: "56489493+jason931225@users.noreply.github.com" };
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const commit = (file, value) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), value);
    git("add", file);
    git("commit", "-qm", "test: stacked queue fixture");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "--initial-branch=dev");
  const lastGreen = commit("backend/app.rs", "old backend");
  const devTip = commit("backend/app.rs", "current backend");
  const firstEntry = commit("backend/app.rs", "queued backend");
  const stacked = commit("apps/web/page.tsx", "queued web");
  const outputs = classifyPaths(git("diff", "--name-only", firstEntry, stacked).split("\n"));
  assert.deepEqual(outputs, { backend: false, web: true });
  for (const sha of [devTip, firstEntry, stacked]) assert.notEqual(sha, lastGreen);
  const release = ci.jobs["backend-release"];
  const github = { event_name: "merge_group", sha: stacked };
  const needs = { affected: { outputs: Object.fromEntries(Object.entries(outputs).map(([k, v]) => [k, String(v)])) } };
  const runs = new Function("github", "needs", "cancelled", `return ${release.if.slice(3, -2)}`);
  assert.equal(runs(github, needs, () => false), true, "web-only stacked entry needs a fresh binary");
  const checkout = release.steps.find(s => s.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout.with.ref ?? github.sha, stacked);
  const download = ci.jobs.home.steps.find(s => s.with?.name === "d10-backend");
  assert.equal(download.with["run-id"], undefined, "Home consumes the stacked entry's build");
});

test("queue producers cover every push consumer and every job gates ci-ok", () => {
  assert.deepEqual([...ci.jobs["ci-ok"].needs].sort(), Object.keys(ci.jobs).filter(n => n !== "ci-ok").sort());
  const evaluate = (condition, event, outputs, job = "") => {
    if (!condition) return true;
    const expression = condition.replace(/^\$\{\{\s*|\s*\}\}$/g, "");
    const needs = { affected: { result: "success", outputs }, "backend-release": { result: event !== "push" && (outputs.backend === "true" || outputs.web === "true") ? "success" : "skipped" }, "states-plan": { result: "success" } };
    return !!new Function("github", "needs", "cancelled", "always", "success", `return ${expression}`)(
      { event_name: event, ref: "refs/heads/dev", job }, needs, () => false, () => true, () => true);
  };
  const active = (job, event, outputs) => {
    const definition = ci.jobs[job];
    if (!evaluate(definition.if, event, outputs, job)) return false;
    // Jobs without a status predicate inherit skipped dependencies, including the states matrix.
    return !!definition.if || [definition.needs ?? []].flat().every(dependency => active(dependency, event, outputs));
  };
  const artifact = (value, job) => value.replace(/\$\{\{.*?\}\}/g, expression => {
    if (expression.includes("tools") || expression.includes("cache.outputs.key")) return "cargo-security-test";
    if (expression.includes("github.job")) return job;
    return "1";
  });
  const uploads = Object.entries(ci.jobs).flatMap(([job, definition]) => (definition.steps ?? [])
    .filter(s => s.uses?.startsWith("actions/upload-artifact@"))
    .map(step => ({ job, definition, step, name: artifact(step.with.name, job) })));
  const consumers = Object.entries(ci.jobs).flatMap(([job, definition]) => (definition.steps ?? [])
    .filter(s => s.uses?.startsWith("actions/download-artifact@") &&
      (s.with["run-id"]?.includes("needs.affected.outputs.run-id") || s.with.name === "ci-proof"))
    .map(step => ({ job, definition, step })));
  assert.ok(consumers.length > 10);
  for (const backend of ["true", "false"]) for (const web of ["true", "false"]) {
    const outputs = { backend, web };
    for (const { job, step } of consumers) {
      if (!active(job, "push", outputs) || !evaluate(step.if, "push", outputs)) continue;
      const pattern = artifact(step.with.name ?? step.with.pattern, job);
      const matches = uploads.filter(upload => pattern.endsWith("*") ? upload.name.startsWith(pattern.slice(0, -1)) : upload.name === pattern);
      const producers = matches.filter(upload => !["dev-artifacts", "states-timings", "release-evidence"].includes(upload.job));
      assert.ok(producers.length, `${job}/${pattern}: no queue producer`);
      for (const upload of producers) {
        assert.ok(active(upload.job, "merge_group", outputs) &&
          evaluate(upload.step.if, "merge_group", outputs, upload.job), `${job}/${upload.job}/${pattern}/${backend}/${web}`);
        if (pattern === "playwright-cache") {
          const exporter = upload.definition.steps.find(s => s.name === "Export browser cache for dev");
          assert.ok(exporter && evaluate(exporter.if, "merge_group", outputs), "browser archive exists before upload");
        }
      }
    }
  }
});

test("backend artifacts have one same-run producer and no staleness or promotion machinery", () => {
  assert.equal(existsSync(new URL("./ci-home-backend.mjs", import.meta.url)), false);
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(workflow, /ci-home-backend|rebuild-backend|Find latest successful trusted dev backend/);
  const uses = Object.entries(ci.jobs).flatMap(([job, definition]) => (definition.steps ?? [])
    .filter(step => step.with?.name === "d10-backend").map(step => ({ job, step })));
  assert.deepEqual(uses.map(({ job }) => job).sort(), ["backend-release", "home"]);
  const upload = uses.find(({ job }) => job === "backend-release").step;
  assert.ok(upload.uses.startsWith("actions/upload-artifact@"));
  assert.equal(upload.if, undefined);
  assert.ok(!upload["continue-on-error"]);
  assert.equal(upload.with.path, "backend/target/release/console-app");
});

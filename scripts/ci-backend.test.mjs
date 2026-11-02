// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const ci = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const backendJobs = ["backend", "backend-gates", "backend-tests", "backend-release"];
const push = "github.event_name == 'push' && github.ref == 'refs/heads/dev'";

for (const name of backendJobs) test(`${name} runs in parallel only for affected candidates and every dev push`, () => {
  const job = ci.jobs[name];
  assert.ok(job, name);
  assert.deepEqual(job.needs, ["affected"]);
  assert.match(job.if, /!cancelled\(\)/);
  const condition = new Function("github", "needs", "cancelled", `return ${job.if.slice(3, -2)}`);
  for (const event of ["pull_request", "merge_group", "push"]) for (const affected of ["true", "false", ""]) {
    assert.equal(condition({ event_name: event }, { affected: { outputs: { backend: affected } } }, () => false), event === "push" || affected === "true");
  }
  assert.ok(job.steps[0].uses.startsWith("step-security/harden-runner@"));
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.ok(!job["continue-on-error"]);
  assert.ok(!job.steps.some(s => s.with?.cache === "npm"));
});

test("Home uses a release artifact on every candidate; every Rust check stays required", () => {
  assert.deepEqual(ci.jobs.home.needs, ["affected", "backend-release"]);
  assert.deepEqual(ci.jobs["d10-probes"].needs, ["backend-release"]);
  for (const name of backendJobs) assert.ok(ci.jobs["ci-ok"].needs.includes(name), name);
  assert.ok(ci.jobs.backend.steps.some(s => s.run === "cargo fmt --check"));
  assert.ok(ci.jobs.backend.steps.some(s => s.run === "cargo clippy --workspace --all-targets --locked -- -D warnings"));
  assert.ok(ci.jobs["backend-gates"].steps.some(s => s.run === "cargo test --locked -p console-gate-migration-safety"));
  assert.ok(ci.jobs["backend-release"].steps.some(s => s.run === "cargo build --release --locked -p console-app --features e2e-test-support"));
});

test("Home runs after deliberate backend skips and requires the trusted dev artifact", () => {
  const home = ci.jobs.home;
  assert.match(home.if ?? "", /!cancelled\(\)/);
  const condition = new Function("github", "needs", "cancelled", `return ${home.if.slice(3, -2)}`);
  for (const event of ["pull_request", "merge_group", "push"]) for (const affected of ["true", "false", ""]) {
    for (const result of ["success", "skipped", "failure", "cancelled"]) for (const cancelled of [false, true]) {
      const needs = { affected: { result: "success", outputs: { backend: affected } }, "backend-release": { result } };
      const allowed = !cancelled && (result === "success" || event !== "push" && affected === "false" && result === "skipped");
      assert.equal(condition({ event_name: event }, needs, () => cancelled), allowed, `${event}/${affected}/${result}/${cancelled}`);
      needs.affected.result = "failure";
      assert.equal(condition({ event_name: event }, needs, () => cancelled), false);
    }
  }
  assert.equal(home.permissions.actions, "read");
  const lookup = home.steps.find(s => s.id === "backend");
  assert.equal(lookup.if, "needs['backend-release'].result == 'skipped'");
  assert.equal(lookup.run, "node scripts/ci-home-backend.mjs");
  assert.equal(lookup.env.GH_TOKEN, "${{ github.token }}");
  const download = home.steps.find(s => s.with?.name === "d10-backend");
  assert.equal(download.with["run-id"], "${{ steps.backend.outputs.run-id || github.run_id }}");
  assert.equal(download.with["github-token"], "${{ github.token }}");
  assert.equal(download.with.path, ".cache/home-backend");
  assert.ok(!download["continue-on-error"]);
  assert.equal(ci.jobs["backend-release"].steps.find(s => s.with?.name === "d10-backend").with["retention-days"], "${{ github.event_name == 'push' && 90 || 1 }}");
  const probe = home.steps.find(s => s.run?.includes("e2e/performance/home-inbox.spec.ts"));
  assert.ok(probe && !probe.if && !probe["continue-on-error"]);
  assert.equal(probe.env.CONSOLE_APP_BIN, ".cache/home-backend/console-app");
  assert.ok(ci.jobs["ci-ok"].needs.includes("home"));
});

test("Home selects only the latest successful same-repository dev push", async () => {
  const { trustedDevBackendRun } = await import("./ci-home-backend.mjs");
  const env = { GITHUB_API_URL: "https://api.github.com", GITHUB_REPOSITORY: "sample/console", GITHUB_REPOSITORY_ID: "42", GH_TOKEN: "test-token" };
  const trusted = { id: 12, event: "push", status: "completed", conclusion: "success", head_branch: "dev", repository: { id: 42 }, head_repository: { id: 42 } };
  const rejected = [
    { event: "pull_request" }, { status: "in_progress" }, { conclusion: "failure" }, { head_branch: "feature" },
    { repository: { id: 99 } }, { head_repository: { id: 99 } }, { head_repository: null },
  ].map(patch => ({ ...trusted, ...patch, id: 13 }));
  const request = runs => async (url, options) => {
    assert.equal(url, "https://api.github.com/repos/sample/console/actions/workflows/ci.yml/runs?branch=dev&event=push&status=success&per_page=100");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    return { ok: true, json: async () => ({ workflow_runs: runs }) };
  };
  assert.equal(await trustedDevBackendRun(env, request([...rejected, trusted, { ...trusted, id: 11 }])), 12);
  for (const run of rejected) await assert.rejects(trustedDevBackendRun(env, request([run])), /No successful trusted dev CI run/);
  await assert.rejects(trustedDevBackendRun(env, request([])), /No successful trusted dev CI run/);
  await assert.rejects(trustedDevBackendRun(env, async () => ({ ok: false, status: 403 })), /GitHub CI runs: HTTP 403/);
});

test("ci-ok accepts only deliberate skips and fails closed on missing classification", () => {
  const job = ci.jobs["ci-ok"], command = job.steps[0].run;
  for (const event of ["pull_request", "merge_group", "push"]) for (const affected of ["true", "false", "", undefined]) {
    const needs = Object.fromEntries(job.needs.map(name => [name, { result: "success" }]));
    needs.affected.outputs = { backend: affected };
    const check = () => spawnSync("bash", ["-e", "-c", command], { encoding: "utf8", env: {
      ...process.env, NEEDS: JSON.stringify(needs), GITHUB_EVENT_NAME: event,
    } });
    assert.equal(check().status, 0, check().stderr);
    for (const name of job.needs) for (const status of ["failure", "cancelled", "skipped"]) {
      needs[name].result = status;
      const allowed = status === "skipped" && event !== "push" && (name === "states-timings" || affected === "false" && backendJobs.includes(name));
      assert.equal(check().status, allowed ? 0 : 1, `${event}/${affected}/${name}/${status}`);
      needs[name].result = "success";
    }
    if (affected === "false" && event !== "push") {
      for (const name of backendJobs) needs[name].result = "skipped";
      assert.equal(check().status, 0, check().stderr);
    }
  }
});

test("parallel builds restore the unchanged trusted cache and publish dev-only deltas to one writer", () => {
  const writer = ci.jobs["backend-cache"];
  assert.ok(writer);
  assert.equal(writer.if, push);
  assert.deepEqual(writer.needs, backendJobs);
  const restore = writer.steps.find(s => s.id === "rust-cache");
  assert.match(restore.with.key, /^backend-.*runner.os.*runner.arch.*backend\/rust-toolchain.toml.*backend\/Cargo.lock.*backend\/\*\*\/Cargo.toml.*github.sha/);
  for (const name of backendJobs) {
    const job = ci.jobs[name];
    assert.deepEqual(job.steps.find(s => s.id === "rust-cache"), restore);
    assert.ok(!job.steps.some(s => s.uses?.startsWith("actions/cache/save@")));
    const delta = job.steps.find(s => s.name === "Collect Rust cache changes");
    assert.equal(delta?.if, push);
    const artifact = job.steps.find(s => s.with?.name?.startsWith("rust-cache-"));
    assert.equal(artifact?.if, push);
    assert.equal(artifact.with["if-no-files-found"], "error");
  }
  const save = writer.steps.find(s => s.uses?.startsWith("actions/cache/save@"));
  assert.equal(save.with.path, restore.with.path);
  assert.equal(save.with.key, "${{ steps.rust-cache.outputs.cache-primary-key }}");
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
    writeFileSync(path.join(home, ".cargo/registry/new"), "registry");
    writeFileSync(path.join(workspace, "backend/target/new"), "executable", { mode: 0o755 });
    const old = path.join(workspace, "backend/target/old");
    writeFileSync(old, "restored"); utimesSync(old, new Date(1000), new Date(1000));
    const oldRegistry = path.join(home, ".cargo/registry/old");
    writeFileSync(oldRegistry, "restored"); utimesSync(oldRegistry, new Date(1000), new Date(1000));
    run(collect.run);
    rmSync(path.join(home, ".cargo"), { recursive: true });
    rmSync(path.join(workspace, "backend/target"), { recursive: true });
    run(merge.run);
    assert.equal(readFileSync(path.join(home, ".cargo/registry/new"), "utf8"), "registry");
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

test("D7 publishes explicit failed upstream status even when backend artifacts are absent", () => {
  const job = ci.jobs["d7-evidence"];
  for (const name of backendJobs) assert.ok(job.needs.includes(name), name);
  assert.match(job.if, /!cancelled\(\)/);
  const record = job.steps.find(s => s.name === "Record upstream evidence status");
  const upload = job.steps.find(s => s.with?.name === "d7-evidence");
  assert.ok(record);
  assert.equal(upload.if, "${{ !cancelled() }}");
  assert.ok(job.steps.indexOf(record) < job.steps.findIndex(s => s.uses?.startsWith("actions/download-artifact@")));
  const root = mkdtempSync(path.join(tmpdir(), "d7-ci-status-"));
  try {
    for (const result of ["success", "failure", "skipped", "cancelled"]) {
      const needs = Object.fromEntries(job.needs.map(name => [name, { result: "success" }]));
      needs.backend.result = result;
      const run = spawnSync("bash", ["-e", "-c", record.run], { cwd: root, encoding: "utf8", env: {
        ...process.env, NEEDS: JSON.stringify(needs), GITHUB_SHA: "a".repeat(40),
      } });
      assert.equal(run.status, 0, run.stderr);
      const status = JSON.parse(readFileSync(path.join(root, ".cache/d7-evidence/ci.json"), "utf8"));
      assert.equal(status.status, result === "success" ? "pass" : "fail");
      assert.equal(status.commit, "a".repeat(40));
      assert.equal(status.jobs.backend.result, result);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

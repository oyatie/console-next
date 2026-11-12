// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const script = new URL("./runner-disk.mjs", import.meta.url).pathname;
const run = (minimum, command, prepare = () => {}) => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-disk-"));
  try {
    const extraEnv = prepare(root);
    const result = spawnSync(process.execPath, [script, "fixture", ...command], { cwd: root, encoding: "utf8", timeout: 15000, env: {
      ...process.env, RUNNER_DISK_MIN_BYTES: minimum, GITHUB_STEP_SUMMARY: path.join(root, "summary"),
      ...extraEnv,
    } });
    return { ...result, root, evidence: readFileSync(path.join(root, ".cache/runner-disk/fixture.log"), "utf8") };
  } finally { rmSync(root, { recursive: true, force: true }); }
};

test("disk guard refuses low space before starting work and leaves evidence", () => {
  const result = run(String(Number.MAX_SAFE_INTEGER), [process.execPath, "-e", "console.log('must not run')"]);
  assert.equal(result.status, 1);
  assert.match(result.evidence, /RUNNER_DISK_LOW.*fixture.*available.*required/);
  assert.doesNotMatch(result.stdout, /must not run/);
});

test("disk guard preserves command failure, both output streams and before/after measurements", () => {
  const result = run("1", [process.execPath, "-e", "console.log('output'); console.error('diagnostic'); process.exit(23)"]);
  assert.equal(result.status, 23, result.stderr);
  for (const text of ["output", "diagnostic", "fixture:before", "fixture:after"]) assert.ok(result.evidence.includes(text), text);
});

test("disk guard supports checkpoints without a command", () => {
  const result = run("1", []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.evidence, /fixture:before/);
});

test("disk guard fails closed for invalid budgets and missing executables", () => {
  for (const minimum of ["", "0", "-1", "1.5", "invalid"]) {
    const result = run(minimum, []);
    assert.equal(result.status, 1);
    assert.match(result.evidence, /RUNNER_DISK_CONFIG/);
  }
  const result = run("1", ["missing-disk-fixture-executable"]);
  assert.equal(result.status, 1);
  assert.match(result.evidence, /ENOENT/);
});

test("disk guard stops a growing process tree before the runner loses its logs", () => {
  const result = run("100", [process.execPath, "-e", "setInterval(() => {}, 1000)"], root => {
    const preload = path.join(root, "measure.cjs");
    writeFileSync(preload, `const fs = require('node:fs'); let calls = 0;
fs.statfsSync = () => ({ bavail: ++calls === 1 ? 1000 : 1, bsize: 1 });
require('node:module').syncBuiltinESMExports();\n`);
    // The child inherits the preload, but only the guard samples the disk.
    return { NODE_OPTIONS: `--require=${preload}` };
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.evidence, /RUNNER_DISK_LOW/);
});

test("database shards guard heavy phases and upload evidence before cache work", () => {
  const workflow = yaml.load(readFileSync(new URL("../.github/workflows/db-tests.yml", import.meta.url), "utf8"));
  const job = workflow.jobs["db-tests"];
  assert.match(job.env.RUNNER_DISK_MIN_BYTES, /vars\.RUNNER_DISK_MIN_BYTES/);
  assert.ok(Number(job.env.RUNNER_DISK_MIN_BYTES.match(/'(\d+)'/)[1]) > 0);
  const run = job.steps.findIndex(step => step.name === "Run duration shard");
  assert.match(job.steps[run].run, /node scripts\/runner-disk.mjs.*node scripts\/backend-tests.mjs --db/);
  const upload = job.steps.findIndex(step => step.with?.name === "db-test-results-${{ matrix.shard }}");
  assert.ok(upload > run && upload < job.steps.findIndex(step => step.id === "cache-budget"));
  assert.equal(job.steps[upload].with.path, "backend/target/nextest/ci/", "preserve the reconciliation artifact layout");
  const diagnostics = job.steps.find(step => step.with?.name === "db-test-diagnostics-${{ matrix.shard }}");
  assert.match(diagnostics.with.path, /\.cache\/runner-disk/);
  assert.equal(diagnostics.with["include-hidden-files"], true);
  assert.equal(diagnostics.if, "${{ !cancelled() }}");
  const budget = job.steps.find(step => step.id === "cache-budget");
  assert.doesNotMatch(budget.run, /-o "\$cache_archive"/);
  assert.match(budget.run, /zstd.*\|.*wc -c/);
});

test("backend working directories write evidence under the workspace artifact root", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-workspace-"));
  try {
    const result = spawnSync(process.execPath, [script, "nested", "bash", "-e", "-o", "pipefail", "-c", "printf 'compiler output'"], {
      cwd: tmpdir(), encoding: "utf8", env: { ...process.env, GITHUB_WORKSPACE: root, RUNNER_DISK_MIN_BYTES: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(path.join(root, ".cache/runner-disk/nested.log"), "utf8"), /compiler output/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("custom workflow shell preserves scripts, environment, working directory and pipe failures", () => {
  const root = mkdtempSync(path.join(tmpdir(), "runner-shell-"));
  try {
    symlinkSync(new URL(".", import.meta.url).pathname, path.join(root, "scripts"), "dir");
    mkdirSync(path.join(root, "backend"));
    const fixture = path.join(root, "fixture.sh");
    for (const [body, expected] of [["printf '%s\\n' \"$VALUE:$PWD\"; exit 23", 23], ["false | true", 1]]) {
      writeFileSync(fixture, body);
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", 'exec runner-disk-shell.sh "$1"', "--", fixture], {
        cwd: path.join(root, "backend"), encoding: "utf8", env: {...process.env, PATH: `${path.join(root, "scripts")}:${process.env.PATH}`, VALUE: "fixture", GITHUB_WORKSPACE: root, RUNNER_DISK_MIN_BYTES: "1"},
      });
      assert.equal(result.status, expected, result.stdout + result.stderr);
    }
    writeFileSync(fixture, "echo must-not-run");
    const refused = spawnSync("bash", [new URL("./runner-disk-shell.sh", import.meta.url).pathname, fixture], {
      cwd: root, encoding: "utf8", env: {...process.env, GITHUB_WORKSPACE: root, RUNNER_DISK_MIN_BYTES: String(Number.MAX_SAFE_INTEGER)},
    });
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /RUNNER_DISK_LOW/);
    assert.doesNotMatch(refused.stdout, /must-not-run/);
    assert.match(readFileSync(path.join(root, ".cache/runner-disk/fixture.log"), "utf8"), /fixture:.*backend/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

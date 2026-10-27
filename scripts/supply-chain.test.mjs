// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const workflow = yaml.load(read(".github/workflows/ci.yml"));
const security = () => {
  assert.ok(workflow.jobs["supply-chain"], "CI must run the supply-chain job");
  return workflow.jobs["supply-chain"];
};

test("npm check runs the register gate and its regression tests", () => {
  const command = JSON.parse(read("package.json")).scripts.check;
  assert.match(command, /node scripts\/check-deps\.mjs\s*&&/);
  assert.match(command, /node --test[^&]*scripts\/check-deps\.test\.mjs/);
  assert.match(command, /node --test[^&]*scripts\/supply-chain\.test\.mjs/);
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

test("ci-ok fails on any failed, cancelled or skipped required job", () => {
  const job = workflow.jobs["ci-ok"];
  assert.ok(job, "required ci-ok aggregate is missing");
  assert.equal(job.if, "${{ always() }}");
  assert.deepEqual([...job.needs].sort(), ["backend", "states", "supply-chain", "web"]);
  const command = job.steps.map((s) => s.run ?? "").join("\n");
  for (const required of job.needs) for (const status of ["success", "failure", "cancelled", "skipped"]) {
    const run = command.replace(/\$\{\{ needs\.([\w-]+)\.result \}\}/g, (_, name) => name === required ? status : "success");
    assert.equal(spawnSync("bash", ["-e", "-c", run]).status, status === "success" ? 0 : 1);
  }
});

test("Dependabot proposes weekly groups for Actions, npm and all Cargo workspaces on dev", () => {
  const config = yaml.load(read(".github/dependabot.yml"));
  assert.equal(config.version, 2);
  assert.deepEqual(config.updates.map((u) => u["package-ecosystem"]).sort(), ["cargo", "github-actions", "npm"]);
  for (const update of config.updates) {
    assert.equal(update.schedule.interval, "weekly");
    assert.equal(update["target-branch"], "dev");
    assert.deepEqual(Object.values(update.groups).map((g) => g.patterns), [["*"]]);
  }
  assert.deepEqual(config.updates.find((u) => u["package-ecosystem"] === "cargo").directories.sort(), ["/apps/desktop/src-tauri", "/backend", "/backend/fuzz"]);
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const build = workflow.jobs["rust-build"].steps.find((s) => s.name === "Build all backend code gates");
const step = workflow.jobs["code-gates"].steps.find((s) => s.name === "Enforce all backend code gates");

function run({ fail = "", buildFailure = false, empty = false } = {}) {
  assert.ok(build && step, "ci-ok must build and run every release code gate");
  const root = mkdtempSync(path.join(tmpdir(), "backend-ci-gates-"));
  try {
    mkdirSync(path.join(root, "bin"));
    mkdirSync(path.join(root, "backend/target/debug"), { recursive: true });
    if (!empty) {
      for (const name of ["alpha", "beta", "gamma"]) {
        const dir = path.join(root, "backend/ci/gates", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "Cargo.toml"), `[package]\nname = "console-gate-${name}"\n`);
        writeFileSync(path.join(root, "backend/target/debug", `console-gate-${name}`), `#!/usr/bin/env bash\nprintf '%s\\n' 'gate console-gate-${name}' >> "$COMMAND_LOG"\nif [[ "$FAIL_GATE" == '${name}' ]]; then exit 1; fi\n`, { mode: 0o755 });
      }
    }
    writeFileSync(path.join(root, "bin/cargo"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == build && "$BUILD_FAILURE" == 1 ]]; then exit 1; fi
`, { mode: 0o755 });
    const log = path.join(root, "commands");
    writeFileSync(log, "");
    const execute = (command) => spawnSync("bash", ["-e", "-o", "pipefail", "-c", command], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, COMMAND_LOG: log,
        FAIL_GATE: fail, BUILD_FAILURE: buildFailure ? "1" : "0" },
    });
    let result = execute(build.run);
    if (result.status === 0) {
      cpSync(path.join(root, ".cache/ci/build/gates"), path.join(root, ".cache/ci/gates"), { recursive: true });
      result = execute(step.run);
    }
    return { status: result.status, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const commands = [
  "build --locked --offline -p console-gate-alpha -p console-gate-beta -p console-gate-gamma",
  ...["alpha", "beta", "gamma"].map((name) => `gate console-gate-${name}`),
];

test("backend runs every discovered gate with the release build and execution arguments", () => {
  assert.deepEqual(run(), { status: 0, calls: commands });
});
test("a red gate fails backend after reporting the remaining gates", () => {
  assert.deepEqual(run({ fail: "beta" }), { status: 1, calls: commands });
});
test("a failed build or missing gate directory cannot pass", () => {
  assert.deepEqual(run({ buildFailure: true }), { status: 1, calls: commands.slice(0, 1) });
  assert.notEqual(run({ empty: true }).status, 0); // GNU sed exits 2, BSD sed 1: any non-zero fails the job
});

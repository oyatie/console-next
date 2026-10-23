// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";

const workflow = yaml.load(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const step = workflow.jobs.backend.steps.find((s) => s.name === "Backend code gates (release parity)");

function run({ fail = "", buildFailure = false, empty = false } = {}) {
  assert.ok(step, "the required backend job must run the release code gates");
  const root = mkdtempSync(path.join(tmpdir(), "backend-ci-gates-"));
  try {
    mkdirSync(path.join(root, "bin"));
    if (!empty) {
      for (const name of ["alpha", "beta", "gamma"]) {
        const dir = path.join(root, "ci/gates", name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "Cargo.toml"), `[package]\nname = "console-gate-${name}"\n`);
      }
    }
    writeFileSync(path.join(root, "bin/cargo"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$COMMAND_LOG"
if [[ "$1" == build && "$BUILD_FAILURE" == 1 ]]; then exit 1; fi
if [[ "$1" == run && "$*" == *"console-gate-$FAIL_GATE" && -n "$FAIL_GATE" ]]; then exit 1; fi
`, { mode: 0o755 });
    const log = path.join(root, "commands");
    writeFileSync(log, "");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step.run], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, COMMAND_LOG: log,
        FAIL_GATE: fail, BUILD_FAILURE: buildFailure ? "1" : "0" },
    });
    return { status: result.status, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const commands = [
  "build --locked --offline -p console-gate-alpha -p console-gate-beta -p console-gate-gamma",
  ...["alpha", "beta", "gamma"].map((name) => `run -q --locked --offline -p console-gate-${name}`),
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

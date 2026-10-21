// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkToolchainPins } from "./check-toolchain-pins.mjs";

test("checkToolchainPins fails when root rust-toolchain.toml is missing", () => {
  const problems = checkToolchainPins("/nonexistent-root-path-xyz");
  assert.ok(problems.some((p) => p.includes("root rust-toolchain.toml is missing")));
});

test("checkToolchainPins fails when a planted sub-crate toolchain mismatches root", () => {
  const rootMock = mkdtempSync(path.join(tmpdir(), "toolchain-mismatch-"));
  mkdirSync(path.join(rootMock, "sub-crate"), { recursive: true });
  writeFileSync(
    path.join(rootMock, "rust-toolchain.toml"),
    '[toolchain]\n# Pinned to stable 1.99.0 for monorepo alignment\nchannel = "1.99.0"\n',
  );
  try {
    writeFileSync(
      path.join(rootMock, "sub-crate", "rust-toolchain.toml"),
      '[toolchain]\nchannel = "1.99.0"\n',
    );
    assert.deepEqual(checkToolchainPins(rootMock), []);
    writeFileSync(
      path.join(rootMock, "sub-crate", "rust-toolchain.toml"),
      '[toolchain]\nchannel = "1.98.1"\n',
    );
    const problems = checkToolchainPins(rootMock);
    assert.ok(problems.some((p) => p.includes('sub-crate/rust-toolchain.toml pins "1.98.1" but root rust-toolchain.toml pins "1.99.0"')));
  } finally {
    rmSync(rootMock, { recursive: true, force: true });
  }
});

test("checkToolchainPins fails when root rust-toolchain.toml has no written reason", () => {
  const rootMock = mkdtempSync(path.join(tmpdir(), "toolchain-no-reason-"));
  mkdirSync(rootMock, { recursive: true });
  writeFileSync(path.join(rootMock, "rust-toolchain.toml"), '[toolchain]\nchannel = "1.99.0"\n');

  try {
    const problems = checkToolchainPins(rootMock);
    assert.ok(problems.some((p) => p.includes("has no written reason")));
  } finally {
    rmSync(rootMock, { recursive: true, force: true });
  }
});

test("checkToolchainPins fails when backend/fuzz lacks nightly justification reason", () => {
  const rootMock = mkdtempSync(path.join(tmpdir(), "toolchain-fuzz-"));
  mkdirSync(path.join(rootMock, "backend/fuzz"), { recursive: true });
  writeFileSync(
    path.join(rootMock, "rust-toolchain.toml"),
    '[toolchain]\n# Pinned to stable 1.99.0 for monorepo alignment\nchannel = "1.99.0"\n',
  );
  writeFileSync(
    path.join(rootMock, "backend/fuzz/rust-toolchain.toml"),
    '[toolchain]\n# Just another nightly\nchannel = "nightly-2026-09-10"\n',
  );

  try {
    const problems = checkToolchainPins(rootMock);
    assert.ok(problems.some((p) => p.includes("must state why nightly is needed")));
  } finally {
    rmSync(rootMock, { recursive: true, force: true });
  }
});

test("checkToolchainPins verifies live repo toolchain pins", () => {
  const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const problems = checkToolchainPins(root);
  assert.deepEqual(problems, []);
});

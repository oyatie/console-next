// SPDX-License-Identifier: LicenseRef-Proprietary
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const tool = (name) => process.env.TOOL_ROOT ? path.join(process.env.TOOL_ROOT, "bin", name) : name;
const fixture = (run) => {
  const root = mkdtempSync(path.join(tmpdir(), "cargo-policy-"));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
};

test("cargo-deny accepts MIT and refuses a deliberately planted GPL licence", () => fixture((root) => {
  mkdirSync(path.join(root, "src"));
  writeFileSync(path.join(root, "src/lib.rs"), "// SPDX-License-Identifier: MIT\n");
  for (const license of ["MIT", "GPL-3.0-only"]) {
    writeFileSync(path.join(root, "Cargo.toml"), `[package]\nname = "policy-fixture"\nversion = "1.0.0"\nlicense = "${license}"\n`);
    const result = spawnSync(tool("cargo-deny"), ["--manifest-path", path.join(root, "Cargo.toml"), "--config", new URL("../backend/deny.toml", import.meta.url).pathname, "--offline", "check", "licenses"], { encoding: "utf8" });
    if (license === "MIT") assert.equal(result.status, 0, result.stdout + result.stderr);
    else assert.notEqual(result.status, 0, result.stdout + result.stderr);
    if (license !== "MIT") assert.match(result.stderr, /GPL-3.0-only/);
  }
}));

test("cargo-audit refuses a vulnerable pin and accepts its patched version using a local advisory", () => fixture((root) => {
  const database = path.join(root, "db");
  const advisory = path.join(database, "crates/policy-fixture");
  mkdirSync(advisory, { recursive: true });
  writeFileSync(path.join(advisory, "RUSTSEC-2026-0001.md"), '```toml\n[advisory]\nid = "RUSTSEC-2026-0001"\npackage = "policy-fixture"\ndate = "2026-01-01"\nurl = "https://rustsec.org/advisories/RUSTSEC-2026-0001.html"\n[versions]\npatched = [">=2.0.0"]\n```\n# Deliberately vulnerable test fixture\nRegression proof only.\n');
  for (const version of ["1.0.0", "2.0.0"]) {
    const lock = path.join(root, "Cargo.lock");
    writeFileSync(lock, `version = 4\n[[package]]\nname = "policy-fixture"\nversion = "${version}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n`);
    const result = spawnSync(tool("cargo-audit"), ["audit", "--no-fetch", "--stale", "--no-yanked", "--db", database, "--file", lock, "--json"], { encoding: "utf8", cwd: root });
    assert.equal(result.status, version === "1.0.0" ? 1 : 0, result.stdout + result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.vulnerabilities.count, version === "1.0.0" ? 1 : 0);
    if (version === "1.0.0") assert.equal(report.vulnerabilities.list[0].advisory.id, "RUSTSEC-2026-0001");
  }
}));

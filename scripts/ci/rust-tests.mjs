// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

// Every partition consumes the same archive; listing never recompiles.
const config = JSON.parse(readFileSync("../scripts/ci/config.json", "utf8"));
const [mode, partition] = process.argv.slice(2);
if (!["unit", "db"].includes(mode) || !Number.isInteger(Number(partition)) || Number(partition) < 1 || Number(partition) > config.nextestPartitions[mode]) throw new Error("invalid Rust test partition");
mkdirSync("../.cache/ci/extracted", { recursive: true });
const junit = "target/nextest/ci/junit.xml";
rmSync(junit, { force: true });
rmSync(junit.replace(".xml", ".baseline.json"), { force: true });
const build = JSON.parse(process.env.CI_RUST_BUILD);
const args = ["--config-file", "../.config/nextest.toml", "--profile", "ci", "--workspace-remap", ".", "-E", build[`${mode}Filter`]];
const disk = spawnSync("python3", ["../scripts/ci/disk-budget.py", "--test"], { stdio: "inherit" });
if (disk.status !== 0) process.exit(1);
const result = spawnSync("cargo", ["nextest", "run", ...args, "--archive-file", "../.cache/ci/workspace.tar.zst", "--extract-to", "../.cache/ci/extracted", "--extract-overwrite", "--partition", `slice:${partition}/${config.nextestPartitions[mode]}`, "--no-tests=pass", "--no-fail-fast", "--failure-output", "never", "--success-output", "never"], { stdio: "inherit" });
// Reuse the extracted metadata for inventory: never extract the archive twice.
const metadata = "../.cache/ci/extracted/target/nextest";
const listed = spawnSync("cargo", ["nextest", "list", ...args, "--cargo-metadata", `${metadata}/cargo-metadata.json`, "--binaries-metadata", `${metadata}/binaries-metadata.json`, "--target-dir-remap", "../.cache/ci/extracted/target", "--message-format", "json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (listed.status !== 0) throw new Error("nextest archive inventory failed");
const inventory = "../.cache/ci/nextest-inventory.json";
writeFileSync(inventory, listed.stdout);
const checked = spawnSync("python3", ["../scripts/ci/test-results.py", "--inventory", "nextest", mode, inventory], { stdio: "inherit", env: { ...process.env, CI_BASELINE_CRATES: build.full ? "null" : JSON.stringify(build.crates) } });
if (checked.status !== 0) process.exit(1);
const proof = spawnSync("python3", ["../scripts/ci/test-results.py", "nextest", mode, junit, String(result.status ?? -1)], { stdio: "inherit" });
process.exit(proof.status ?? 1);

// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";

// The build matrix archives only this affected package group and test mode.
const config = JSON.parse(readFileSync("../scripts/ci/config.json", "utf8"));
const [mode, partition] = process.argv.slice(2);
if (!["unit", "db"].includes(mode) || !Number.isInteger(Number(partition)) || Number(partition) < 1 || Number(partition) > config.nextestPartitions) throw new Error("invalid Rust test partition");
mkdirSync("../.cache/ci/extracted", { recursive: true });
const junit = "target/nextest/ci/junit.xml";
rmSync(junit, { force: true });
rmSync(junit.replace(".xml", ".baseline.json"), { force: true });
const result = spawnSync("cargo", ["nextest", "run", "--config-file", "../.config/nextest.toml", "--profile", "ci", "--archive-file", "../.cache/ci/workspace.tar.zst", "--workspace-remap", ".", "--extract-to", "../.cache/ci/extracted", "--partition", `slice:${partition}/${config.nextestPartitions}`, "--no-tests=pass", "--no-fail-fast", "--failure-output", "never", "--success-output", "never"], { stdio: "inherit" });
const proof = spawnSync("python3", ["../scripts/ci/test-results.py", "nextest", mode, junit, String(result.status ?? -1)], { stdio: "inherit" });
process.exit(proof.status ?? 1);

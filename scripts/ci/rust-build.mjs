// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const build = JSON.parse(process.env.CI_RUST_BUILD);
if (!Array.isArray(build.crates) || build.crates.some((name) => !/^[a-z][a-z0-9_-]*$/.test(name)) || (!build.crates.length && process.env.CI_HOSTED_SOURCE !== "base")) throw new Error("invalid Rust packages");
const output = path.resolve("../.cache/ci/build/tests");
mkdirSync(output, { recursive: true });
for (const file of ["workspace.tar.zst", "source.json"]) rmSync(`${output}/${file}`, { force: true });
if (process.env.CI_HOSTED_SOURCE) writeFileSync(`${output}/source.json`, JSON.stringify({ source: process.env.CI_HOSTED_SOURCE, sha: process.env.CI_SOURCE_SHA, empty: build.crates.length === 0 }));
if (!build.crates.length) process.exit(0);
const result = spawnSync("cargo", ["nextest", "archive", ...build.crates.flatMap((name) => ["-p", name]), "--tests", "--locked", ...(build.features ? ["--features", build.features] : []), "--archive-file", `${output}/workspace.tar.zst`], { stdio: "inherit", cwd: process.env.CI_SOURCE_ROOT ? `${process.env.CI_SOURCE_ROOT}/backend` : process.cwd() });
process.exit(result.status ?? 1);

// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const build = JSON.parse(process.env.CI_RUST_BUILD);
if (!build.crates?.length || build.crates.some((name) => !/^[a-z][a-z0-9_-]*$/.test(name))) throw new Error("invalid Rust packages");
mkdirSync("../.cache/ci/build/tests", { recursive: true });
const result = spawnSync("cargo", ["nextest", "archive", ...build.crates.flatMap((name) => ["-p", name]), "--tests", "--locked", ...(build.features ? ["--features", build.features] : []), "--archive-file", "../.cache/ci/build/tests/workspace.tar.zst"], { stdio: "inherit" });
process.exit(result.status ?? 1);

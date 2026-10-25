// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync } from "node:fs";
import path from "node:path";

const source = process.env.CI_HOSTED_SOURCE;
if (!["base", "head"].includes(source)) throw new Error("invalid hosted source");
const requested = process.env[source === "base" ? "CI_BASE_SHA" : "CI_HEAD_SHA"];
if (!/^[a-f0-9]{40}$/.test(requested ?? "")) throw new Error("hosted source needs a full commit SHA");
const sha = execFileSync("git", ["rev-parse", "--verify", `${requested}^{commit}`], { encoding: "utf8" }).trim();
if (execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() !== process.env.CI_HEAD_SHA) throw new Error("hosted harness checkout does not match the run SHA");
const root = source === "base" ? path.resolve(".cache/ci/source") : process.cwd();
if (source === "base") execFileSync("git", ["worktree", "add", "--detach", root, sha], { stdio: "inherit" });
const build = JSON.parse(process.env.CI_RUST_BUILD);
if (source === "base") {
  copyFileSync(".client-data-allow", `${root}/.client-data-allow`);
  execFileSync("python3", ["scripts/client-data-scan.py", "--root", root, "--tree"], { stdio: "inherit" });
  const packages = JSON.parse(execFileSync("cargo", ["metadata", "--manifest-path", `${root}/backend/Cargo.toml`, "--format-version", "1", "--no-deps", "--locked", "--offline"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).packages;
  build.crates = build.crates.filter((name) => packages.some((p) => p.name === name));
  build.features = build.features.split(",").filter((feature) => {
    const [name, flag] = feature.split("/");
    return packages.some((p) => p.name === name && Object.hasOwn(p.features, flag));
  }).join(",");
}
for (const [key, value] of Object.entries({ CI_SOURCE_SHA: sha, CI_SOURCE_ROOT: root, CI_SCAN_SOURCE_ROOT: root, CI_RUST_BUILD: JSON.stringify(build) })) {
  appendFileSync(process.env.GITHUB_ENV, `${key}=${value}\n`);
}

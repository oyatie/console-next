// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";

const group = JSON.parse(process.env.CI_RUST_GROUP);
if (!group.crates?.length || group.crates.some((name) => !/^[a-z][a-z0-9_-]*$/.test(name))) throw new Error("invalid Rust package group");
for (const mode of group.modes) {
  const targets = group.targets.filter((target) => target.mode === mode);
  const unique = [...new Map(targets.map((target) => [target.kind === "lib" ? "lib" : `${target.kind}:${target.target}`, target])).values()];
  const args = unique.flatMap((target) => [target.kind === "lib" ? "--lib" : `--${target.kind}`, ...(target.kind === "lib" ? [] : [target.target])]);
  const filter = targets.map((target) => `(package(=${target.crate}) & kind(${target.kind}) & binary(=${target.target}))`).join(" + ");
  const directory = `../.cache/ci/build/tests/${mode}`;
  mkdirSync(directory, { recursive: true });
  const result = spawnSync("cargo", ["nextest", "archive", ...group.crates.flatMap((name) => ["-p", name]), ...args, "--locked", ...(group.features ? ["--features", group.features] : []), "-E", filter, "--archive-file", `${directory}/workspace.tar.zst`], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

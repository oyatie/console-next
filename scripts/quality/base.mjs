// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";

export function ratchet(findings, baseline) {
  const problems = [];
  for (const key of new Set([...Object.keys(findings), ...Object.keys(baseline)])) {
    const now = findings[key] ?? 0, old = baseline[key] ?? 0;
    if (key in baseline && (!Number.isSafeInteger(old) || old < 1)) problems.push(`${key}: invalid baseline count`);
    else if (now !== old) problems.push(`${key}: now ${now}, baseline ${old}; ${now > old ? "new debt" : "remove/lower stale baseline"}`);
  }
  return problems;
}

export function baselineGrowth(current, previous) {
  return Object.keys(current).filter((key) => current[key] > (previous[key] ?? 0)).map((key) => `${key}: baseline must only shrink`);
}

export function qualityRef(root) {
  if (process.env.QUALITY_BASE) return process.env.QUALITY_BASE;
  const upstream = spawnSync("git", ["rev-parse", "--abbrev-ref", "dev@{upstream}"], { cwd: root, encoding: "utf8" });
  if (upstream.status === 0) return upstream.stdout.trim();
  const remote = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd: root });
  const origin = spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/dev"], { cwd: root });
  const base = remote.status === 0 && origin.status === 0 ? "origin/dev" : "dev";
  console.error(`quality base: ${base} (dev has no upstream; set one with git branch --set-upstream-to=<remote>/dev dev, or QUALITY_BASE=<ref>)`);
  return base;
}

// Git distinguishes a missing path from an invalid base; unknown evidence must not become green.
export function atBase(root, base, file) {
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const valid = git(["rev-parse", "--verify", `${base}^{commit}`]);
  if (valid.status !== 0) throw new Error(`quality: cannot resolve base ${base}: ${valid.stderr}`);
  const list = git(["ls-tree", "--name-only", base, "--", file]);
  if (list.status !== 0) throw new Error(list.stderr);
  if (!list.stdout.trim()) return undefined;
  const result = git(["show", `${base}:${file}`]);
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}

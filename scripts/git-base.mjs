// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// A local dev can belong to the private repository; only CI evidence or remote refs are authoritative.
export function resolveBase(root = process.cwd(), { base, env = process.env } = {}) {
  const hint = "set CI_BASE_SHA to a fetched base commit, or fetch origin/dev or public/dev";
  let requested = base || env.CI_BASE_SHA;
  if (!requested && env.GITHUB_EVENT_PATH) {
    let event;
    try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")); }
    catch (error) { throw new Error(`git base: cannot read event: ${error.message}; ${hint}`); }
    requested = event.pull_request?.base.sha || event.merge_group?.base_sha || event.before;
    if (/^0+$/.test(requested ?? "")) requested = undefined;
  }
  const candidates = requested ? [requested] : ["refs/remotes/origin/dev", "refs/remotes/public/dev"];
  for (const ref of candidates) {
    const result = spawnSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: root, encoding: "utf8" });
    if (result.status === 0) return result.stdout.trim();
  }
  throw new Error(`git base: cannot resolve ${requested ? `requested base ${JSON.stringify(requested)}` : "a remote dev base"}; ${hint}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { console.log(resolveBase(process.cwd(), { base: process.argv[2] })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

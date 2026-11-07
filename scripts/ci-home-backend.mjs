#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { classifyPaths } from "./ci-affected.mjs";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function trustedDevBackendRun(env, request = fetch) {
  const response = await request(`${env.GITHUB_API_URL}/repos/${env.GITHUB_REPOSITORY}/actions/workflows/ci.yml/runs?branch=dev&event=push&status=success&per_page=100`, {
    headers: { Authorization: `Bearer ${env.GH_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (!response.ok) throw new Error(`GitHub CI runs: HTTP ${response.status}`);
  const { workflow_runs: runs } = await response.json();
  const run = runs.find(r => r.event === "push" && r.status === "completed" && r.conclusion === "success"
    && r.head_branch === "dev" && r.repository?.id === Number(env.GITHUB_REPOSITORY_ID)
    && r.head_repository?.id === Number(env.GITHUB_REPOSITORY_ID));
  if (!run) throw new Error("No successful trusted dev CI run; Home requires a trusted backend artifact");
  let unchanged = false;
  try {
    if ([run.head_sha, env.GITHUB_SHA].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ""))) {
      const git = (...args) => execFileSync("git", args, { cwd: env.GITHUB_WORKSPACE, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      git("merge-base", "--is-ancestor", run.head_sha, env.GITHUB_SHA);
      const paths = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", run.head_sha, env.GITHUB_SHA, "--");
      unchanged = !classifyPaths(paths.split("\0").filter(Boolean)).backend;
    }
  } catch { /* An unavailable or unrelated range requires a fresh backend. */ }
  if (!unchanged) throw new Error("CI_HOME_BACKEND_STALE: fallback backend range changed or is unknown");
  return run.id;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const runId = await trustedDevBackendRun(process.env);
    appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${runId}\nrebuild-backend=false\n`);
  } catch (error) {
    if (!process.argv.includes("--rebuild-if-stale")) throw error;
    appendFileSync(process.env.GITHUB_OUTPUT, "rebuild-backend=true\n");
  }
}

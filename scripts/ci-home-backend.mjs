#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
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
  return run.id;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const runId = await trustedDevBackendRun(process.env);
  appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${runId}\n`);
}

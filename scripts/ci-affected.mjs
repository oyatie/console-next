#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function classifyPaths(paths) {
  const affected = { backend: false, web: false };
  for (const file of paths) {
    if (/^(?:docs\/.*\.md|[^/]+\.md)$/.test(file)) continue;
    // The web contract gate reads both committed backend OpenAPI documents.
    if (file.startsWith("backend/openapi/")) affected.backend = affected.web = true;
    else if (/^(?:backend\/|Cargo\.[^/]+$|rust-toolchain(?:\.toml)?$|migrations\/|openapi(?:\/|\.))/.test(file)) affected.backend = true;
    else if (/^(?:apps\/|packages\/|e2e\/|package[^/]*\.json$)/.test(file)) affected.web = true;
    else affected.backend = affected.web = true;
  }
  return affected;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [event, base, head] = process.argv.slice(2);
  if (!["push", "pull_request", "merge_group"].includes(event)) throw new Error("CI_AFFECTED_EVENT: unsupported event");
  let affected = { backend: true, web: true };
  if (event !== "push") {
    if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ""))) throw new Error("CI_AFFECTED_SHA: expected base and head commit SHAs");
    const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const ancestor = git("merge-base", base, head).trim();
    // Disable rename detection so both the removed and added path are classified.
    const paths = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", ancestor, head, "--");
    affected = classifyPaths(paths.split("\0").filter(Boolean));
  }
  const output = `backend=${affected.backend}\nweb=${affected.web}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function classifyPaths(paths) {
  const affected = { backend: false, web: false };
  for (const file of paths) {
    // The web contract gate reads both committed backend OpenAPI documents.
    if (/^packages\/i18n\/src\/catalogs\/[^/]+\/import\.ts$/.test(file)) affected.backend = affected.web = true;
    else if (file.startsWith("backend/openapi/")) affected.backend = affected.web = true;
    else if (/^(?:backend\/|Cargo\.[^/]+$|rust-toolchain(?:\.toml)?$|migrations\/|openapi(?:\/|\.))/.test(file)) affected.backend = true;
    else if (/^(?:apps\/|packages\/|e2e\/|package[^/]*\.json$)/.test(file)) affected.web = true;
    // The web source gate reads all reviewed docs. The program register and Cedar specs also feed Rust tests and code.
    else if (/^docs\/(?:adr|architecture|authz|design|design-system|ops|product|quality|security|templates|testing|ui-target)\//.test(file) ||
      file === "docs/engineering.md" || file === "docs/testing.md") affected.web = true;
    else affected.backend = affected.web = true;
  }
  return affected;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [event, base, head] = process.argv.slice(2);
  if (!["push", "pull_request", "merge_group"].includes(event)) throw new Error("CI_AFFECTED_EVENT: unsupported event");
  let affected = { backend: true, web: true };
  let docs = "none";
  let lockfile = true;
  if (event !== "push") {
    if (![base, head].every(sha => /^[a-f0-9]{40}$/.test(sha ?? ""))) throw new Error("CI_AFFECTED_SHA: expected base and head commit SHAs");
    const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const ancestor = git("merge-base", base, head).trim();
    // Disable rename detection so both the removed and added path are classified.
    const paths = git("diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", ancestor, head, "--");
    const files = paths.split("\0").filter(Boolean);
    affected = classifyPaths(files);
    lockfile = files.includes("package-lock.json");
    if (!lockfile) {
      const reason = `Skipping npm signature verification: package-lock.json unchanged against ${base}`;
      console.log(reason);
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, reason + "\n");
    }
    const docCount = files.filter(file => file.startsWith("docs/")).length;
    if (docCount) docs = docCount === files.length ? "only" : "mixed";
  }
  const output = `backend=${affected.backend}\nweb=${affected.web}\ndocs=${docs}\nlockfile=${lockfile}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}

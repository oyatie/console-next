// SPDX-License-Identifier: LicenseRef-Proprietary
// Usage: node scripts/check-repo-files.mjs [base-ref | --full]. Default: the PR base, or dev locally.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

export const policy = JSON.parse(readFileSync(new URL("./repo-files.policy.json", import.meta.url), "utf8"));

export function fileProblems(file, bytes) {
  const problems = policy.rules.filter((rule) => rule.paths.some((glob) => matchesGlob(file.toLowerCase(), glob)) && !rule.allow.some((glob) => matchesGlob(file, glob))).map((rule) => rule.id);
  if (bytes > policy.maxFileBytes) problems.push("max-file-size");
  return problems;
}

export function checkRepoFiles({ full = false, base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "dev" } = {}) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const changed = full ? null : new Set(git("diff", "--name-only", "--no-renames", "--diff-filter=ACMT", "-z", `${base}...HEAD`, "--").split("\0").filter(Boolean));
  // Read committed sizes, not working files: local edits and symlink targets cannot hide a large blob.
  const files = git("ls-tree", "-rlz", "HEAD").split("\0").filter(Boolean).map((entry) => {
    const tab = entry.indexOf("\t");
    const bytes = entry.slice(0, tab).trim().split(/\s+/)[3];
    return { file: entry.slice(tab + 1), bytes: bytes === "-" ? 0 : Number(bytes) };
  }).filter(({ file }) => full || changed.has(file));
  return { count: files.length, problems: files.flatMap(({ file, bytes }) => fileProblems(file, bytes).map((rule) => `${JSON.stringify(file)}: ${rule}`)) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [mode, ...extra] = process.argv.slice(2);
    if (extra.length || (mode?.startsWith("-") && mode !== "--full")) throw new Error("usage: check-repo-files.mjs [base-ref | --full]");
    const result = checkRepoFiles(mode === "--full" ? { full: true } : mode ? { base: mode } : {});
    for (const problem of result.problems) process.stderr.write(`repository files: ${problem}\n`);
    process.stdout.write(`repository files: ${result.count} checked, ${result.problems.length} problem(s)\n`);
    process.exitCode = result.problems.length ? 1 : 0;
  } catch (error) {
    process.stderr.write(`repository files: ${error.message}\n`);
    process.exitCode = 1;
  }
}

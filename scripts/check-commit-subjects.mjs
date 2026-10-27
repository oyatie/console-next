#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// config-conventional types with Conventional Commits 1.0.0 grammar and Git's default revert subject.
export const isConventionalSubject = (subject) => /^(?:(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^\s()]+\))?!?: \S.*|Revert ".+")$/iu.test(subject);

function main() {
  const [baseRef, headRef, event, ...extra] = process.argv.slice(2);
  if (!baseRef || !headRef || extra.length || !["pull_request", "merge_group"].includes(event)) {
    throw new Error("usage: check-commit-subjects.mjs <base> <head> <pull_request|merge_group>");
  }
  const git = (...args) => execFileSync("git", ["--no-replace-objects", ...args], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
  const resolve = (ref) => git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  const base = resolve(baseRef), head = resolve(headRef);
  const log = git("log", "--no-show-signature", "--format=%H%x00%P%x00%s", `${base}..${head}`, "--");
  if (!log) throw new Error("commit subjects: empty range; verify the base and head revisions");
  const commits = new Map(log.split("\n").map((line) => {
    const [hash, parents, subject] = line.split("\0");
    return [hash, { parents: parents ? parents.split(" ") : [], subject }];
  }));
  if (event === "merge_group") {
    // The queue's first-parent chain must reach its advertised base.
    let current = head;
    while (current !== base) {
      const commit = commits.get(current);
      if (!commit) throw new Error("commit subjects: merge group base is not on the first-parent chain");
      current = commit.parents[0];
    }
  }
  const checked = [...commits].filter(([, commit]) => commit.parents.length <= 1);
  const failures = checked.filter(([, commit]) => !isConventionalSubject(commit.subject));
  for (const [hash, commit] of failures) console.error(`${hash}: invalid Conventional Commit subject ${JSON.stringify(commit.subject)}`);
  console.log(`commit subjects: ${checked.length} commit(s) checked, ${commits.size - checked.length} merge(s) exempt, ${failures.length} failure(s)`);
  if (failures.length) {
    console.error("Expected <type>[optional scope][!]: <description>; reword each listed commit before merging.");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`commit subjects: ${error.message}`);
    process.exitCode = 1;
  }
}

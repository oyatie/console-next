// SPDX-License-Identifier: LicenseRef-Proprietary
// Licence headers on new files (docs/audits/public-readiness-2026-10-13.md §3.2). Every source file ADDED after
// the base ref carries `SPDX-License-Identifier: LicenseRef-Proprietary` in its first lines. That identifier is the
// one backend/Cargo.toml already declares, and it means "no licence granted; see LICENSE". Existing files are not
// back-filled by this check (a ratchet: new files only). Formats without comments (JSON, lockfiles, images) and
// vendored third-party code, which keeps its own licence, are out of scope.
//   node scripts/check-license-headers.mjs [base-ref]   (default: CI evidence, then remote dev)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveBase } from "./git-base.mjs";

export const HEADER = "SPDX-License-Identifier: LicenseRef-Proprietary";
const EXT = /\.(?:[cm]?[jt]sx?|rs|sh|py|css|sql|ya?ml|toml|html)$/;
const SKIP = /(?:^|\/)(?:node_modules|dist|vendor|third-party|test-results[^/]*)\//;
const HEAD_LINES = 5;

/** Whether `file` must carry the header. */
export const checked = (file) => EXT.test(file) && !SKIP.test(file);

/** The header problems in one added file (empty = pass). */
export function headerProblems(file, src) {
  if (!checked(file)) return [];
  const head = src.split("\n").slice(0, HEAD_LINES).join("\n");
  if (head.includes(HEADER)) return [];
  const other = head.match(/SPDX-License-Identifier:\s*(\S+)/);
  return [
    other
      ? `${file}: declares ${other[1]}; our files declare ${HEADER} (third-party code belongs under third-party/ or vendor/)`
      : `${file}: missing "${HEADER}" in the first ${HEAD_LINES} lines`,
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = resolveBase(process.cwd(), { base: process.argv[2] });
  const added = execFileSync("git", ["diff", "--merge-base", base, "--name-only", "--diff-filter=A"], { encoding: "utf8" })
    .split("\n")
    .filter(checked);
  const problems = added.flatMap((f) => headerProblems(f, readFileSync(f, "utf8")));
  for (const p of problems) console.error(p);
  console.log(`licence headers: ${added.length} added source file(s) checked, ${problems.length} problem(s)`);
  process.exit(problems.length ? 1 : 0);
}

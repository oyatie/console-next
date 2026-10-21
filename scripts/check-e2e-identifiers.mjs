// SPDX-License-Identifier: LicenseRef-Proprietary
// E2E specs take registration identifiers from e2e/registration-identifiers.json, never from inline literals:
// a literal that drifts from the fixture the helpers register times out on rows that never appear (r13, 2026-10-19).
// Baseline files may keep their literals (refusal fixtures, parity captures) but the list only shrinks.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const e2e = join(root, "e2e");
const baselinePath = join(e2e, "identifier-literals-baseline.json");
const literal = /\b\d{3}-\d{2}-\d{5}\b|\b\d{6}-\d{7}\b|\b\d{10}\b|\b\d{13}\b/; // BRN (3-2-5 or a bare 10-digit run) and CRN (6-7 or a bare 13-digit run)

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|mts)$/.test(name)) files.push(p);
  }
};
walk(e2e);

const hits = files.filter((f) => literal.test(readFileSync(f, "utf8"))).map((f) => relative(root, f)).sort();
const baseline = JSON.parse(readFileSync(baselinePath, "utf8")).files.sort();
const added = hits.filter((f) => !baseline.includes(f));
const cleaned = baseline.filter((f) => !hits.includes(f));

console.log(`e2e-identifiers: ${hits.length} files with inline identifier literals, baseline ${baseline.length}`);
if (cleaned.length) console.log(`e2e-identifiers: now clean, remove from the baseline: ${cleaned.join(", ")}`);
if (added.length) {
  console.error(`e2e-identifiers: FAILED, inline identifier literals outside the baseline: ${added.join(", ")}`);
  console.error("Use REGISTRATION_FIXTURES / brnDisplay() from e2e/setup-flows.ts instead.");
  process.exit(1);
}
if (cleaned.length) process.exit(1);

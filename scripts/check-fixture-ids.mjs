// SPDX-License-Identifier: LicenseRef-Proprietary
// Fixture RRNs must fail the 주민등록번호 checksum (docs/audits/public-readiness-2026-10-13.md §6 P-6): a
// checksum-valid 13-digit number may be a real person's. That includes the 11–12-digit form Excel leaves when it
// strips the leading zeros of a 2000s birth year, which the backend's importer reads as an RRN
// (backend/crates/hr/domain/src/import/pii.rs is_stripped_zero_rrn, mirrored here). Scans every tracked text file
// outside docs/ (in the public monorepo that includes backend/; docs/ is not published) and prints file:line only,
// never the number. Run it from the backend repository's root to scan that tree.
// BRN/CRN fixtures use the unallocated 000 prefix; tests retain valid and mismatched check digits as needed.
//   node scripts/check-fixture-ids.mjs
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const syntheticRanges = JSON.parse(readFileSync(new URL("./fixture-synthetic-ranges.json", import.meta.url), "utf8"));

export function syntheticPhone(index) {
  if (!Number.isInteger(index) || index < 0 || index > 9999) throw new Error("synthetic phone index outside four-digit range");
  return `010-${syntheticRanges.phoneMiddle.find((value) => value.length === 4)}-${String(index).padStart(4, "0")}`;
}

export function syntheticRrn(body) {
  if (!/^\d{12}$/.test(body)) throw new Error("synthetic RRN body must have twelve digits");
  const crnCheck = (10 - [...body].reduce((sum, digit, i) => sum + Number(digit) * (1 + i % 2), 0) % 10) % 10;
  const digit = [...Array(10).keys()].find((value) => value !== crnCheck && !rrnChecksumValid(body + value));
  return `${body.slice(0, 6)}-${body.slice(6)}${digit}`;
}

const RRN = /(?<!\d)(\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))-?([1-8]\d{6})(?!\d)/g;
const W = [2, 3, 4, 5, 6, 7, 8, 9, 2, 3, 4, 5];
// 11–12 digits, no leading zero, an optional Excel ".0" (pii.rs is_stripped_zero_rrn).
const STRIPPED = /(?<![\d.])([1-9]\d{10,11})(?:\.0)?(?![\d])/g;

/** Whether 13 digits satisfy the RRN check digit. */
export function rrnChecksumValid(digits) {
  const d = [...digits].map(Number);
  return (11 - (W.reduce((s, w, i) => s + w * d[i], 0) % 11)) % 10 === d[12];
}

/** The 13 digits an 11–12-digit Excel value stands for, when it is a stripped 2000s RRN (pii.rs is_stripped_zero_rrn). */
export function strippedZeroRrn(whole) {
  if (!/^[1-9]\d{10,11}$/.test(whole)) return null;
  const p = whole.padStart(13, "0");
  const [year, month, day] = [2000 + Number(p.slice(0, 2)), Number(p.slice(2, 4)), Number(p.slice(4, 6))];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return "3478".includes(p[6]) && month >= 1 && month <= 12 && day >= 1 && day <= days ? p : null;
}

/** 1-based line numbers in `text` that carry a checksum-valid RRN, whole or in its stripped-zero form. */
export function validRrnLines(text) {
  return text.split("\n").flatMap((line, i) =>
    [...line.matchAll(RRN)].some((m) => rrnChecksumValid(m[1] + m[2])) ||
    [...line.matchAll(STRIPPED)].some((m) => {
      const p = strippedZeroRrn(m[1]);
      return p !== null && rrnChecksumValid(p);
    })
      ? [i + 1]
      : [],
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter((f) => f && !f.startsWith("docs/"));
  const hits = [];
  for (const f of files) {
    let buf;
    try { buf = readFileSync(f); } catch { continue; }
    if (buf.includes(0)) continue;
    for (const n of validRrnLines(buf.toString("utf8"))) hits.push(`${f}:${n}`);
  }
  for (const h of hits) console.error(`${h}: checksum-valid RRN; change a digit so the checksum fails`);
  console.log(`fixture ids: ${files.length} tracked files, ${hits.length} checksum-valid RRN(s)`);
  process.exit(hits.length ? 1 : 0);
}

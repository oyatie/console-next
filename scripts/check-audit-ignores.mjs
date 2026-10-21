#!/usr/bin/env node
// cargo-audit and cargo-deny each keep their own advisory ignore list
// (backend/.cargo/audit.toml, backend/deny.toml). They drifted once: audit.toml
// kept two quick-xml IDs after the lock moved to the fixed release. This gate
// fails when the two sets differ, or when any ignore lacks a reason and an
// unexpired expiry. Every ignore line must read:
//   "RUSTSEC-YYYY-NNNN", # expires YYYY-MM-DD: <reason>
// cargo-audit's ignore is a plain string array, so the reason and expiry live
// in the trailing comment, in the same shape in both files.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_DAYS = 180;
const LINE = /^\s*"(RUSTSEC-\d{4}-\d{4})",\s*#\s*expires (\d{4}-\d{2}-\d{2}):\s*(\S.*)$/;

/** Parse the `ignore = [ ... ]` array under [advisories]. */
export function parseIgnores(text, label) {
  const block = text.match(/^\[advisories\][\s\S]*?^ignore\s*=\s*\[([\s\S]*?)^\]/m);
  if (!block) return { entries: [], failures: [`${label}: no [advisories] ignore array`] };
  const entries = [];
  const failures = [];
  for (const line of block[1].split("\n")) {
    if (!/RUSTSEC-/.test(line.replace(/#.*$/, ""))) continue;
    const m = line.match(LINE);
    if (m) entries.push({ id: m[1], expires: m[2], reason: m[3] });
    else {
      failures.push(`${label}: ignore needs '"ID", # expires YYYY-MM-DD: reason': ${line.trim()}`);
      // Still count the ID, so a malformed line cannot also hide drift.
      for (const [id] of line.matchAll(/RUSTSEC-\d{4}-\d{4}/g)) entries.push({ id, expires: "9999-12-31", malformed: true });
    }
  }
  return { entries, failures };
}

export function auditIgnoreFailures(auditText, denyText, today = new Date().toISOString().slice(0, 10)) {
  const audit = parseIgnores(auditText, "audit.toml");
  const deny = parseIgnores(denyText, "deny.toml");
  const failures = [...audit.failures, ...deny.failures];
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + MAX_DAYS * 864e5).toISOString().slice(0, 10);
  for (const [label, { entries }] of [["audit.toml", audit], ["deny.toml", deny]]) {
    for (const e of entries.filter((x) => !x.malformed)) {
      if (e.expires <= today) failures.push(`${label}: ${e.id} expired on ${e.expires}; re-triage it`);
      if (e.expires > horizon) failures.push(`${label}: ${e.id} expiry ${e.expires} is more than ${MAX_DAYS} days out`);
    }
  }
  const a = new Set(audit.entries.map((e) => e.id));
  const d = new Set(deny.entries.map((e) => e.id));
  for (const id of a) if (!d.has(id)) failures.push(`${id} is ignored in audit.toml but not in deny.toml`);
  for (const id of d) if (!a.has(id)) failures.push(`${id} is ignored in deny.toml but not in audit.toml`);
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(new URL("..", import.meta.url).pathname);
  const failures = auditIgnoreFailures(
    readFileSync(resolve(root, "backend/.cargo/audit.toml"), "utf8"),
    readFileSync(resolve(root, "backend/deny.toml"), "utf8"),
  );
  for (const f of failures) console.error(`check-audit-ignores: ${f}`);
  process.exit(failures.length ? 1 : 0);
}

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { auditIgnoreFailures } from "./check-audit-ignores.mjs";

const root = new URL("..", import.meta.url).pathname;
const toml = (ids) => `[advisories]\nignore = [\n${ids.join("\n")}\n]\n`;
const ok = (id, expires = "2027-01-01") => `  "${id}", # expires ${expires}: build-time only`;
const today = "2026-10-09";

test("the repo's audit.toml and deny.toml ignore the same advisories, each with a live expiry", () => {
  const failures = auditIgnoreFailures(
    readFileSync(`${root}backend/.cargo/audit.toml`, "utf8"),
    readFileSync(`${root}backend/deny.toml`, "utf8"),
  );
  assert.deepEqual(failures, []);
});

test("equal sets with reasons and expiries pass", () => {
  assert.deepEqual(auditIgnoreFailures(toml([ok("RUSTSEC-2023-0071")]), toml([ok("RUSTSEC-2023-0071")]), today), []);
});

test("drift between the two lists is refused in both directions", () => {
  const f = auditIgnoreFailures(toml([ok("RUSTSEC-2023-0071"), ok("RUSTSEC-2026-0194")]), toml([ok("RUSTSEC-2023-0071"), ok("RUSTSEC-2024-0436")]), today);
  assert.ok(f.some((x) => x.includes("RUSTSEC-2026-0194 is ignored in audit.toml but not in deny.toml")));
  assert.ok(f.some((x) => x.includes("RUSTSEC-2024-0436 is ignored in deny.toml but not in audit.toml")));
});

test("an ignore without a reason or expiry is refused", () => {
  const f = auditIgnoreFailures(toml(['  "RUSTSEC-2023-0071",']), toml(['  "RUSTSEC-2023-0071", # just because']), today);
  assert.equal(f.filter((x) => x.includes("needs")).length, 2);
});

test("an expired ignore is refused, and so is one dated beyond the horizon", () => {
  const f = auditIgnoreFailures(toml([ok("RUSTSEC-2023-0071", "2026-10-09")]), toml([ok("RUSTSEC-2023-0071", "2099-01-01")]), today);
  assert.ok(f.some((x) => x.includes("expired on 2026-10-09")));
  assert.ok(f.some((x) => x.includes("more than 180 days out")));
});

test("a file with no ignore array is refused rather than read as empty", () => {
  assert.ok(auditIgnoreFailures("[advisories]\n", toml([]), today).some((x) => x.includes("no [advisories] ignore array")));
});

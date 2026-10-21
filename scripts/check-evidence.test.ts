// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkEvidence } from "./check-evidence.mjs";

const now = new Date("2026-10-21T00:00:00Z");
const quarantine = { version: 1, maxAgeHours: 24, entries: [] };
function report() {
  return {
    errors: [],
    stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0, startTime: now.toISOString(), duration: 100 },
    suites: [{ title: "journey", specs: [{ id: "certificate", tests: [{
      projectName: "parallel", expectedStatus: "passed", status: "expected",
      results: [{ status: "passed", errors: [] }],
    }] }] }],
  };
}
const entry = { testId: "certificate", projectName: "parallel", owner: "HR", reason: "tracked flake", expires: "2026-10-22" };
function skipped() {
  const r = report();
  r.stats.expected = 0;
  r.stats.skipped = 1;
  const run = r.suites[0].specs[0].tests[0];
  run.status = "skipped";
  run.results[0].status = "skipped";
  r.suites[0].specs.push({ ...report().suites[0].specs[0], id: "executed-control" });
  r.stats.expected = 1;
  return r;
}

test("evidence accepts completed runs and nested suites", () => {
  expect(checkEvidence(report(), quarantine, now)).toEqual([]);
  const r = report();
  expect(checkEvidence({ ...r, suites: [{ suites: r.suites }] }, quarantine, now)).toEqual([]);
});

test.each([null, {}, { stats: report().stats, suites: [] }, { ...report(), suites: [{}] }])(
  "missing or empty evidence cannot pass (%j)", (r) => {
    expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
  },
);

test.each(["failed", "timedOut", "interrupted", "unknown", "skipped"])("%s is not executed passing evidence", (status) => {
  const r = report();
  r.suites[0].specs[0].tests[0].results[0].status = status;
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
});

test("a retry that turns green still exposes the failed attempt", () => {
  const r = report();
  r.suites[0].specs[0].tests[0].results.unshift({ status: "failed", errors: [] });
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
});

test("an entirely quarantined suite is not execution evidence", () => {
  const r = skipped();
  r.suites[0].specs.pop();
  r.stats.expected = 0;
  expect(checkEvidence(r, { ...quarantine, entries: [entry] }, now).length).toBeGreaterThan(0);
});

test.each(["expected", "unexpected", "flaky", "skipped"] as const)("summary %s must match the actual test tree", (key) => {
  const r = report();
  r.stats[key]++;
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
});

test.each([-1, 0.5, "1", null])("invalid summary counts are refused (%j)", (expected) => {
  expect(checkEvidence({ ...report(), stats: { ...report().stats, expected } }, quarantine, now).length).toBeGreaterThan(0);
});

test("missing results, hidden errors, expected failures and duplicate tests are refused", () => {
  const r = report();
  const run = r.suites[0].specs[0].tests[0];
  expect(checkEvidence({ ...r, errors: [{ message: "setup failed" }] }, quarantine, now).length).toBeGreaterThan(0);
  run.results[0].errors.push({ message: "hidden" } as never);
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
  run.results = [];
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
  run.results = [{ status: "passed", errors: [] }];
  run.expectedStatus = "failed";
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
  run.expectedStatus = "passed";
  r.suites[0].specs[0].tests.push(run);
  r.stats.expected++;
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
});

test("a skipped test needs an owned, unexpired quarantine for the same project", () => {
  const r = skipped();
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
  expect(checkEvidence(r, { ...quarantine, entries: [entry] }, now)).toEqual([]);
  expect(checkEvidence(r, { ...quarantine, entries: [{ ...entry, projectName: "firefox" }] }, now).length).toBeGreaterThan(0);
});

test.each([
  { owner: "" }, { reason: "" }, { expires: "2026-10-20" }, { expires: "2026-02-30" },
  { expires: "tomorrow" }, { testId: "" }, { projectName: "" },
])("invalid quarantine refuses evidence (%j)", (change) => {
  expect(checkEvidence(skipped(), { ...quarantine, entries: [{ ...entry, ...change }] }, now).length).toBeGreaterThan(0);
});

test("duplicate and malformed quarantine files are refused", () => {
  for (const q of [null, {}, { ...quarantine, version: 2 }, { ...quarantine, entries: [entry, entry] }])
    expect(checkEvidence(report(), q, now).length).toBeGreaterThan(0);
});

test("CLI refuses absent/malformed evidence and accepts a completed report", () => {
  const dir = mkdtempSync(join(tmpdir(), "check-evidence-"));
  const file = join(dir, "report.json");
  const cli = (...args: string[]) => spawnSync(process.execPath, [join(import.meta.dirname, "check-evidence.mjs"), ...args], { encoding: "utf8" });
  try {
    expect(cli().status).toBe(1);
    expect(cli(file).status).toBe(1);
    writeFileSync(file, "{");
    expect(cli(file).status).toBe(1);
    const r = report();
    r.stats.startTime = new Date().toISOString();
    writeFileSync(file, JSON.stringify(r));
    expect(cli(file).status).toBe(0);
    expect(cli(file, "--unknown").status).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["", "invalid", "2026-10-19T00:00:00Z", "2026-10-22T00:00:00Z"])("missing, stale or future report timestamps are refused (%j)", (startTime) => {
  const r = report();
  r.stats.startTime = startTime;
  expect(checkEvidence(r, quarantine, now).length).toBeGreaterThan(0);
});

test.each([0, -1, "24", null])("proof freshness policy must be positive (%j)", (maxAgeHours) => {
  expect(checkEvidence(report(), { ...quarantine, maxAgeHours }, now).length).toBeGreaterThan(0);
});

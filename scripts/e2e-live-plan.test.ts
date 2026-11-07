// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import { livePlan } from "./e2e-live-plan.mjs";
import { listedTests } from "./e2e-timings.mjs";

const inventory = (count = 12) => ({ errors: [], suites: Array.from({ length: count }, (_, i) => ({
  file: `${i}.spec.ts`, specs: Array.from({ length: i + 1 }, (_, n) => ({ title: `test ${n}`,
    tests: [{ projectName: "parallel", expectedStatus: "passed" }] })),
})) });

test("live plans preserve whole fixtures exactly once in eight nonempty bounded jobs", () => {
  const report = inventory();
  report.suites.push({ file: "quarantined.spec.ts", specs: [{ title: "known issue", tests: [{ projectName: "parallel", expectedStatus: "skipped" }] }] });
  const shards = livePlan(report);
  expect(shards).toHaveLength(8);
  expect(shards.every(shard => shard.files.length && shard.est <= 2400)).toBe(true);
  expect(shards.flatMap(shard => shard.files).sort()).toEqual(report.suites.map(suite => suite.file).sort());
});

test("live discovery errors cannot produce an executable plan", () => {
  expect(() => livePlan({ ...inventory(), errors: [{ message: "discovery failed" }] })).toThrow("LIVE_DISCOVERY_FAILED");
});

test("empty and mixed-browser inventories cannot produce an executable plan", () => {
  expect(() => livePlan(inventory(0))).toThrow("LIVE_INVALID_INVENTORY");
  const report = inventory();
  report.suites[0].specs[0].tests[0].projectName = "firefox";
  expect(() => livePlan(report)).toThrow("LIVE_INVALID_INVENTORY");
});

test("capacity mismatches and an oversized fixture fail before browsers start", () => {
  expect(() => livePlan(inventory(7))).toThrow("LIVE_SHARD_CAPACITY");
  const report = inventory();
  const timings = Object.fromEntries(listedTests(report).map(test => [test.key, { s: 5000 }]));
  expect(() => livePlan(report, timings)).toThrow("E2E_SPEC_OVER_BUDGET");
});

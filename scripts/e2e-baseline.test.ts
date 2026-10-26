// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";

const sample = (outcome: string, durations: number[]) => ({
  title: outcome, tests: [{ projectName: "parallel", status: outcome, expectedStatus: outcome === "skipped" ? "skipped" : "passed",
    results: durations.map((duration) => ({ duration, status: "passed" })) }],
});
const report = (specs: ReturnType<typeof sample>[]) => ({
  config: { workers: 2 }, errors: [],
  stats: { expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
  suites: [{ file: "journey.spec.ts", specs }],
});

test("baseline includes retries and failures in spec durations, with a separate flake denominator", async () => {
  const { summarize } = await import("./e2e-baseline.mjs");
  const result = summarize(report([sample("expected", [100]), sample("flaky", [200, 300]), sample("unexpected", [400, 500]), sample("skipped", [0])]), 2500);
  expect(result).toMatchObject({ wall_ms: 2500, executed: 3, flaky: 1, failed: 1, flake_rate: 1 / 3 });
  expect(result.specs).toEqual({ "parallel/journey.spec.ts": 1500 });
});

test("baseline refuses an incomplete run and a worker count other than two", async () => {
  const { summarize } = await import("./e2e-baseline.mjs");
  expect(() => summarize({ ...report([]), errors: [{ message: "server failed" }] }, 1000)).toThrow(/incomplete/);
  expect(() => summarize({ ...report([]), config: { workers: 4 } }, 1000)).toThrow(/workers/);
});

test("three-run summary computes nearest-rank p50 and p95 and refuses different coverage", async () => {
  const { aggregate } = await import("./e2e-baseline.mjs");
  const run = (ms: number) => ({ wall_ms: ms, executed: 2, flaky: 1, failed: 0, specs: { "parallel/a.spec.ts": ms }, coverage: ["a", "b"] });
  expect(aggregate([run(100), run(300), run(200)])).toMatchObject({
    wall_ms: { p50: 200, p95: 300 }, flake_rate: 0.5,
    specs: { "parallel/a.spec.ts": { p50: 200, p95: 300 } },
  });
  expect(() => aggregate([run(100)])).toThrow(/three/);
  expect(() => aggregate([run(100), run(200), { ...run(300), coverage: ["a"] }])).toThrow(/coverage/);
});

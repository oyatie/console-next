// SPDX-License-Identifier: LicenseRef-Proprietary
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";

const sample = (outcome: string, durations: number[]) => ({
  title: outcome, tests: [{ projectName: "parallel", status: outcome, expectedStatus: outcome === "skipped" ? "skipped" : "passed",
    results: durations.map((duration) => ({ duration, status: outcome === "skipped" ? "skipped" : outcome === "unexpected" ? "failed" : "passed" })) }],
});
const report = (specs: ReturnType<typeof sample>[]) => ({
  config: { workers: 2 }, errors: [],
  stats: { expected: 1, unexpected: 1, flaky: 1, skipped: 1 },
  suites: [{ file: "journey.spec.ts", specs }],
});

test("baseline includes retries and failures in spec durations, with a separate flake denominator", async () => {
  const { summarize, aggregate } = await import("./e2e-baseline.mjs");
  const result = summarize(report([sample("expected", [100]), sample("flaky", [200, 300]), sample("unexpected", [400, 500]), sample("skipped", [0])]), 2500);
  expect(result).toMatchObject({ wall_ms: 2500, executed: 3, flaky: 1, failed: 1, flake_rate: 1 / 3 });
  expect(result.specs).toEqual({ "parallel/journey.spec.ts": 1500 });
  expect(result.spec_statuses).toEqual({ "parallel/journey.spec.ts": { expected: 1, flaky: 1, unexpected: 1, skipped: 1 } });
  expect(result.complete).toBe(true);
  expect(aggregate([result, result, result])).toMatchObject({ failed: [1, 1, 1], flake_rate: 1 / 3,
    specs: { "parallel/journey.spec.ts": { p50: 1500, p95: 1500 } } });
});

test("runner errors retain completed spec measurements but cannot enter a baseline", async () => {
  const { summarize, aggregate } = await import("./e2e-baseline.mjs");
  const errors = [{ message: "worker crashed after a spec finished" }];
  const result = summarize({ ...report([sample("unexpected", [400])]), errors }, 1000);
  expect(result).toMatchObject({ complete: false, errors, wall_ms: 1000, executed: 1, failed: 1,
    specs: { "parallel/journey.spec.ts": 400 }, spec_statuses: { "parallel/journey.spec.ts": { unexpected: 1 } } });
  expect(() => aggregate([result, result, result])).toThrow(/incomplete/);
});

test("a failed dependency retains its duration and its skipped dependent has no timing sample", async () => {
  const { summarize, aggregate } = await import("./e2e-baseline.mjs");
  const dependency = sample("unexpected", [250]);
  dependency.tests[0].projectName = "setup";
  dependency.tests[0].results[0].status = "failed";
  const dependent = sample("skipped", []);
  dependent.tests[0].expectedStatus = "passed";
  const input = report([dependency]);
  input.suites.push({ file: "dependent.spec.ts", specs: [dependent] });
  const result = summarize(input, 1000);
  expect(result).toMatchObject({ complete: false, executed: 1, failed: 1, flake_rate: 0,
    specs: { "setup/journey.spec.ts": 250, "parallel/dependent.spec.ts": null },
    spec_statuses: { "setup/journey.spec.ts": { unexpected: 1 }, "parallel/dependent.spec.ts": { unexecuted: 1 } } });
  expect(result.coverage).toHaveLength(2);
  expect(() => aggregate([result, result, result])).toThrow(/incomplete/);
});

test("an interrupted retry retains all attempt durations and marks the run incomplete", async () => {
  const { summarize, aggregate } = await import("./e2e-baseline.mjs");
  const interrupted = sample("unexpected", [200, 150]);
  interrupted.tests[0].results[1].status = "interrupted";
  const result = summarize(report([sample("expected", [100]), interrupted]), 1000);
  expect(result).toMatchObject({ complete: false, executed: 2, failed: 1,
    specs: { "parallel/journey.spec.ts": 450 }, spec_statuses: { "parallel/journey.spec.ts": { expected: 1, interrupted: 1 } } });
  expect(() => aggregate([result, result, result])).toThrow(/incomplete/);
});

test("missing results retain the other tests and never become zero-duration passes", async () => {
  const { summarize } = await import("./e2e-baseline.mjs");
  const result = summarize(report([sample("expected", [100]), sample("unexpected", [])]), 1000);
  expect(result).toMatchObject({ complete: false, executed: 1,
    specs: { "parallel/journey.spec.ts": 100 }, spec_statuses: { "parallel/journey.spec.ts": { expected: 1, unexecuted: 1 } } });
});

test.each([{ specs: [] }, { specs: [sample("skipped", [0])] }])("an empty or entirely skipped run is retained without a flake denominator", async ({ specs }) => {
  const { summarize, aggregate } = await import("./e2e-baseline.mjs");
  const result = summarize(report(specs), 1000);
  expect(result).toMatchObject({ complete: false, wall_ms: 1000, executed: 0, flake_rate: null });
  expect(() => aggregate([result, result, result])).toThrow(/incomplete/);
});

test("no suites after a setup failure retains the runner error and wall time", async () => {
  const { summarize } = await import("./e2e-baseline.mjs");
  const errors = [{ message: "server failed" }];
  expect(summarize({ ...report([]), suites: [], errors }, 1000)).toMatchObject({
    complete: false, errors, wall_ms: 1000, specs: {}, spec_statuses: {}, coverage: [],
  });
});

test("baseline refuses a worker count other than two", async () => {
  const { summarize } = await import("./e2e-baseline.mjs");
  expect(() => summarize({ ...report([]), config: { workers: 4 } }, 1000)).toThrow(/workers/);
});

test.each([0, -1, NaN, Infinity, -Infinity])("baseline refuses invalid wall time %s even when tests ran", async (wall) => {
  const { summarize } = await import("./e2e-baseline.mjs");
  expect(() => summarize(report([sample("expected", [100])]), wall)).toThrow(/wall time/);
});

test("three-run summary computes nearest-rank p50 and p95 and refuses different coverage", async () => {
  const { aggregate } = await import("./e2e-baseline.mjs");
  const run = (ms: number) => ({ complete: true, wall_ms: ms, executed: 2, flaky: 1, failed: 0, specs: { "parallel/a.spec.ts": ms }, coverage: ["a", "b"] });
  expect(aggregate([run(100), run(300), run(200)])).toMatchObject({
    wall_ms: { p50: 200, p95: 300 }, flake_rate: 0.5,
    specs: { "parallel/a.spec.ts": { p50: 200, p95: 300 } },
  });
  expect(() => aggregate([run(100)])).toThrow(/three/);
  expect(() => aggregate([run(100), run(200), { ...run(300), coverage: ["a"] }])).toThrow(/coverage/);
  expect(() => aggregate([run(100), run(200), { ...run(300), specs: { "parallel/b.spec.ts": 300 } }])).toThrow(/executed coverage/);
});

test("deliberately skipped specs have null percentiles, and changing executed coverage is refused", async () => {
  const { summarize, aggregate } = await import("./e2e-baseline.mjs");
  const input = report([sample("expected", [100])]);
  input.suites.push({ file: "optional.spec.ts", specs: [sample("skipped", [0])] });
  const run = summarize(input, 1000);
  expect(run.complete).toBe(true);
  expect(aggregate([run, run, run]).specs["parallel/optional.spec.ts"]).toEqual({ p50: null, p95: null });
  input.suites[1].specs[0].tests = sample("expected", [200]).tests;
  expect(() => aggregate([run, run, summarize(input, 1000)])).toThrow(/executed coverage/);
});

test.each(["dependency", "coverage", "missing report"])("collector retains all six runs after %s trouble", async (problem) => {
  const argv = process.argv, exitCode = process.exitCode;
  const writes: string[] = [];
  let repetition = 0, now = 0;
  vi.resetModules();
  vi.doMock("node:os", () => ({ platform: () => "linux", availableParallelism: () => 2 }));
  vi.doMock("node:child_process", () => ({ spawnSync: (_command: string, args: string[]) => {
    if (args[0] === "rev-parse") return { status: 0, stdout: "revision\n" };
    repetition++;
    return { status: problem === "dependency" && repetition === 1 ? 1 : 0 };
  } }));
  vi.doMock("node:fs", () => ({ mkdirSync: vi.fn(), rmSync: vi.fn(),
    writeFileSync: (_file: string, body: string) => writes.push(body),
    readFileSync: () => {
      if (problem === "missing report" && repetition === 1) throw new Error("report missing");
      const input = report([sample("expected", [100])]);
      if (problem === "dependency" && repetition === 1) {
        input.suites[0].specs.push(sample("unexpected", [250]));
        const dependent = sample("skipped", []);
        dependent.tests[0].expectedStatus = "passed";
        input.suites.push({ file: "dependent.spec.ts", specs: [dependent] });
      }
      if (problem === "coverage" && repetition === 3) input.suites[0].file = "different.spec.ts";
      return JSON.stringify(input);
    } }));
  const timer = vi.spyOn(performance, "now").mockImplementation(() => now += 1000);
  try {
    process.argv = [process.execPath, fileURLToPath(new URL("e2e-baseline.mjs", import.meta.url)), "/tmp/baseline-test"];
    await import("./e2e-baseline.mjs");
    const evidence = JSON.parse(writes.at(-1)!);
    expect(repetition).toBe(6);
    expect(process.exitCode).toBe(1);
    expect(evidence.browsers.chromium.runs).toHaveLength(3);
    expect(evidence.browsers.chromium.summary).toBeUndefined();
    expect(evidence.browsers.chromium.summary_error).toMatch(/incomplete|coverage/);
    expect(evidence.browsers.firefox.runs).toHaveLength(3);
    expect(evidence.browsers.firefox.summary.wall_ms).toEqual({ p50: 1000, p95: 1000 });
    expect(evidence.browsers.chromium.runs[0].wall_ms).toBe(1000);
    if (problem === "dependency") expect(evidence.browsers.chromium.runs[0]).toMatchObject({
      exit_code: 1, failed: 1, specs: { "parallel/journey.spec.ts": 350, "parallel/dependent.spec.ts": null },
      spec_statuses: { "parallel/dependent.spec.ts": { unexecuted: 1 } },
    });
    if (problem === "missing report") expect(evidence.browsers.chromium.runs[0].error).toMatch(/report missing/);
  } finally {
    timer.mockRestore();
    process.argv = argv;
    process.exitCode = exitCode;
    vi.doUnmock("node:os");
    vi.doUnmock("node:child_process");
    vi.doUnmock("node:fs");
    vi.resetModules();
  }
});

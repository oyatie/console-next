import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { admitted, listedTests, maxLoadPerCore, plan, record } from "./e2e-timings.mjs";

const t = (project: string, file: string, title = "t") => ({ project, file, key: `${project} › ${file} › ${title}` });
const timed = (pairs: [ReturnType<typeof t>, number][]) => Object.fromEntries(pairs.map(([x, s]) => [x.key, { s, at: 0 }]));

test("one job when the whole run fits the target", () => {
  const a = t("parallel", "a.spec.ts");
  expect(plan([a], timed([[a, 400]]), { target: 300, workers: 4, boot: 40 })).toEqual([]);
});

test("packs whole files longest-first into ceil(estimate / budget) shards per project; unknown tests get the median", () => {
  const big = t("parallel", "big.spec.ts"), mid = t("parallel", "mid.spec.ts"), small = t("parallel", "small.spec.ts");
  const fresh = t("parallel", "fresh.spec.ts");
  const clock = t("clock", "j5.spec.ts");
  // parallel: 800 + 400 + 300 + median 400 = 1,900 s / 4 workers over a 260 s budget → 2 shards; clock: 400 s → 2 shards (1 file).
  const jobs = plan([big, mid, small, fresh, clock], timed([[big, 800], [mid, 400], [small, 300], [clock, 400]]), { target: 300, workers: 4, boot: 40 });
  expect(jobs).toEqual([
    { project: "parallel", files: ["big.spec.ts", "small.spec.ts"], est: 315 },
    { project: "parallel", files: ["mid.spec.ts", "fresh.spec.ts"], est: 240 },
    { project: "clock", files: ["j5.spec.ts"], est: 440 },
  ]);
});

test("record folds runs by EWMA and drops entries no run refreshed in 30 days", () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "timings-")), "timings.json");
  record({ old: 5, a: 10 }, { file, now: 0 });
  record({ a: 20 }, { file, now: 31 * 86_400_000 });
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ a: { s: 15, at: 31 * 86_400_000 } });
});

test("listedTests skips fixme tests and keys nested describes", () => {
  const report = {
    suites: [
      {
        file: "a.spec.ts",
        specs: [{ title: "fixme", tests: [{ projectName: "parallel", expectedStatus: "skipped" }] }],
        suites: [{ title: "group", specs: [{ title: "runs", tests: [{ projectName: "clock", expectedStatus: "passed" }] }] }],
      },
    ],
  };
  expect(listedTests(report)).toEqual([{ project: "clock", file: "a.spec.ts", key: "clock › a.spec.ts › group › runs" }]);
});

test("admission: a job waits while the 1-minute load is above the per-core cap, and 0 turns it off", () => {
  expect(admitted(36, 18, 2)).toBe(true);
  expect(admitted(36.1, 18, 2)).toBe(false);
  expect(admitted(500, 18, 0)).toBe(true);
});

test("the cap defaults to 2 per core and refuses a value that is not a number >= 0", () => {
  expect(maxLoadPerCore(undefined)).toBe(2);
  expect(maxLoadPerCore("1.5")).toBe(1.5);
  expect(maxLoadPerCore("0")).toBe(0);
  for (const bad of ["", "abc", "-1", "Infinity"]) expect(() => maxLoadPerCore(bad)).toThrow(/E2E_MAX_LOAD_PER_CORE/);
});

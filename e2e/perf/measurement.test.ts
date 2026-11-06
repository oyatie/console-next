// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import { budget, readBudget, readHarness, readYaml } from "./budget";
import { registration } from "./fixture";
import { assertBudget, percentile, requestKey, summarize, type Sample } from "./measurement";

const sample: Sample = { lcp_ms: 100, ttfb_ms: 20, longest_task_ms: null, ready_ms: 110, final_path: "/sample", requests: {}, repeated_requests: [], errors: [] };
const samples = () => Array.from({ length: budget.samples }, () => ({ ...sample }));

test("the checked-in SLO owns the objective, compliance and fixture shape", () => {
  expect(budget.ms).toBe(2000);
  expect(budget.target).toBe(0.995);
  expect(budget.shape).toEqual({ employees: 2000, entities: 5, workplaces: 40, departments: 300 });
  const slo = readYaml(new URL("../../backend/app/slos/page-load.openslo.yaml", import.meta.url)) as { metadata: unknown; spec: { objectives: { op: string; value: number; target: number }[] } };
  for (const change of [{ value: 0 }, { target: 2 }, { op: "gte" }]) {
    expect(() => readBudget({ ...slo, spec: { objectives: [{ ...slo.spec.objectives[0], ...change }] } })).toThrow();
  }
});

test("p95 uses nearest rank without changing the raw samples", () => {
  const values = Array.from({ length: 20 }, (_, i) => 20 - i);
  expect(percentile(values, 0.95)).toBe(19);
  expect(values[0]).toBe(20);
});

test("the lab harness settings must be bounded and positive", () => {
  const lab = readYaml(new URL("./lab.yaml", import.meta.url)) as { samples_per_cache: number; run_timeout_seconds: number };
  for (const value of ["0", "-1", "not-a-duration", "1e30"]) {
    expect(() => readHarness({ ...lab, run_timeout_seconds: value })).toThrow();
  }
});

test("additional corporations keep unique, unallocated registration numbers", () => {
  const ids = Array.from({ length: budget.shape.entities }, (_, i) => registration(i));
  expect(new Set(ids.map(id => id.brn)).size).toBe(budget.shape.entities);
  expect(new Set(ids.map(id => id.crn)).size).toBe(budget.shape.entities);
  expect(ids.every(id => id.brn.startsWith("000") && id.crn.startsWith("000"))).toBe(true);
});

test("request keys retain the concrete URL and body", () => {
  const first = "https://console.invalid/api/v1/employees/1?view=card";
  expect(requestKey("GET", first, null)).toBe("GET /api/v1/employees/1?view=card");
  expect(requestKey("GET", first, "first")).not.toBe(requestKey("GET", first, "second"));
  expect(requestKey("GET", first, null)).not.toBe(requestKey("GET", first.replace("/1", "/2"), null));
});

describe("the budget gate cannot read missing or failed measurements as green", () => {
  test("a complete cold sample passes", () => {
    const row = summarize("/people", "cold", samples());
    expect(row.status).toBe("pass");
    expect(row.lcp_p95_ms).toBe(100);
    expect(() => assertBudget(row)).not.toThrow();
  });
  for (const [name, change] of [
    ["missing LCP", { lcp_ms: null }],
    ["held read", { lcp_ms: budget.ms + 500 }],
    ["failed read", { errors: ["GET /api/v1/employees 503"] }],
    ["repeated GET", { requests: { "GET /api/v1/employees/1": 2 }, repeated_requests: ["GET /api/v1/employees/1"] }],
  ] as [string, Partial<Sample>][]) {
    test(name, () => {
      const row = summarize("/people", "warm", samples().map(s => ({ ...s, ...change })));
      expect(row.status).toBe(change.lcp_ms === null || change.errors?.length ? "unknown" : "fail");
      expect(() => assertBudget(row)).toThrow(/\/people warm/);
    });
  }
  test("one slow tail fails the 99.5% objective even when p95 passes", () => {
    const values = samples();
    values[0] = { ...sample, lcp_ms: budget.ms + 500 };
    const row = summarize("/", "cold", values);
    expect(row.lcp_p95_ms).toBeLessThan(budget.ms);
    expect(row.status).toBe("fail");
    expect(() => assertBudget(row)).toThrow();
  });
  test("empty and undersampled rows are unknown", () => {
    for (const values of [[], [sample]]) {
      expect(summarize("/", "cold", values).status).toBe("unknown");
      expect(() => assertBudget(summarize("/", "cold", values))).toThrow();
    }
  });
});

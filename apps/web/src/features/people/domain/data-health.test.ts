// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import {
  DATA_HEALTH_CATEGORIES,
  buildCategorySummaries,
  completenessRate,
  kpiCategory,
  kpiSummary,
  mapDrilldownItems,
  type PeopleDataHealthResponse,
} from "./data-health";

function sampleHealth(overrides: Partial<PeopleDataHealthResponse> = {}): PeopleDataHealthResponse {
  return {
    cohort: { total: 20, active: 15, on_leave: 2, pre_hire: 3 },
    statutory_register: {
      complete_count: 14,
      incomplete_count: 6,
      missing_by_category: {
        birth: 1,
        job: 2,
        hire: 1,
        contract_end: 1,
        sex: 1,
        address: 3,
        career: 4,
      },
    },
    id_summary: {
      rrn_recorded: 16,
      not_issued: 2,
      missing: 2,
      by_type: { rrn: 12, arc: 3, domestic_residence: 1, not_issued: 2, unset: 2 },
    },
    placement_summary: { placed: 17, unplaced: 2, department_missing: 1 },
    bank_account: { registered: 17, missing: 3 },
    identity_review: { needs_review: 1 },
    failed_actions: { count: 1 },
    drilldown_items: [
      {
        employee_id: "00000000-0000-4000-8000-000000000001",
        employee_number: "10587",
        employment_status: "ACTIVE",
        missing_categories: ["address", "rrn_missing"],
      },
      {
        employee_id: "abcdef12-0000-4000-8000-000000000002",
        employment_status: "PRE_HIRE",
        missing_categories: ["bank_account_missing", "unplaced"],
      },
    ],
    latest_import: {
      run_id: "00000000-0000-4000-8990-000000000001",
      status: "APPLIED",
      candidate_rows: 18,
      created_at: "2026-11-09T01:00:00Z",
      applied_at: "2026-11-09T01:05:00Z",
    },
    ...overrides,
  };
}

describe("data-health domain", () => {
  test("completenessRate clamps to 0..100, treats zero cohort as 100%, and never reports 100% when missing > 0", () => {
    expect(completenessRate(0, 0)).toBe(100);
    expect(completenessRate(20, 0)).toBe(100);
    expect(completenessRate(20, 4)).toBe(80);
    expect(completenessRate(2056, 1)).toBe(99);
    expect(completenessRate(2056, 6)).toBe(99);
    expect(completenessRate(5, 8)).toBe(0);
  });

  test("buildCategorySummaries maps all 14 server categories and drilldown IDs", () => {
    const data = sampleHealth();
    const summaries = buildCategorySummaries(data);
    expect(summaries.map((s) => s.id)).toEqual([...DATA_HEALTH_CATEGORIES]);
    expect(summaries.find((s) => s.id === "address")).toMatchObject({ missing: 3, total: 20, rate: 85, destination: "grid" });
    expect(summaries.find((s) => s.id === "rrn_missing")).toMatchObject({
      missing: 2,
      destination: "roster",
      drilldownIds: ["00000000-0000-4000-8000-000000000001"],
    });
    expect(summaries.find((s) => s.id === "bank_account_missing")).toMatchObject({
      missing: 3,
      destination: "roster",
      drilldownIds: ["abcdef12-0000-4000-8000-000000000002"],
    });
    expect(summaries.find((s) => s.id === "register_incomplete")).toMatchObject({ missing: 6, rosterReview: "register" });
    expect(summaries.find((s) => s.id === "department_missing")).toMatchObject({ missing: 1, destination: "unplaced" });
  });

  test("kpiSummary and kpiCategory compute aggregate KPI tiles and server category mapping", () => {
    const data = sampleHealth();
    expect(kpiSummary(data)).toEqual({
      all: 20,
      register: 6,
      unplaced: 3,
      identity: 5,
      actionsContracts: 4,
    });
    expect(kpiCategory("all", data)).toBeNull();
    expect(kpiCategory("register", data)).toBe("register_incomplete");
    expect(kpiCategory("unplaced", data)).toBe("unplaced");
    expect(kpiCategory("identity", data)).toBe("rrn_missing");
    expect(kpiCategory("actionsContracts", data)).toBe("failed_action");

    const deptOnly = sampleHealth({
      placement_summary: { placed: 19, unplaced: 0, department_missing: 1 },
      id_summary: { rrn_recorded: 20, not_issued: 0, missing: 0, by_type: { rrn: 20, arc: 0, domestic_residence: 0, not_issued: 0, unset: 0 } },
      failed_actions: { count: 0 },
    });
    expect(kpiCategory("unplaced", deptOnly)).toBe("department_missing");
    expect(kpiCategory("identity", deptOnly)).toBe("identity_review");
    expect(kpiCategory("actionsContracts", deptOnly)).toBe("bank_account_missing");
  });

  test("mapDrilldownItems formats de-identified labels without raw PII", () => {
    const items = mapDrilldownItems(sampleHealth());
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      employeeId: "00000000-0000-4000-8000-000000000001",
      label: "#10587",
      employmentStatus: "ACTIVE",
      unplacedKind: null,
    });
    expect(items[1]).toMatchObject({
      employeeId: "abcdef12-0000-4000-8000-000000000002",
      label: "#abcdef12",
      employmentStatus: "PRE_HIRE",
      unplacedKind: "workplace",
    });
  });
});

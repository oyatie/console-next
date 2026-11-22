// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import {
  buildCategorySummaries,
  buildHealthRows,
  classifyEmployeeGaps,
  completenessRate,
  filterHealthRows,
  kpiCounts,
} from "./data-health";

type Employee = components["schemas"]["Employee"];
type EmployeeFacets = components["schemas"]["EmployeeFacets"];
type Fact = components["schemas"]["RegisterFactsQueryItem"];

function emp(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-1",
    company: "Saeon",
    name: "Person One",
    employee_number: "10001",
    org_unit_id: "unit-1",
    legal_entity_id: "ent-1",
    workplace_id: "wp-1",
    job: "Engineer",
    hire_date: "2024-01-02",
    status: "ACTIVE",
    home_branch_review_required: false,
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    register_review_required: false,
    next_event: null,
    failed_event: null,
    created_at: "2024-01-02T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    ...overrides,
  };
}

describe("data-health domain", () => {
  test("completenessRate clamps to 0..100 and treats zero population as 100%", () => {
    expect(completenessRate(0, 0)).toBe(100);
    expect(completenessRate(10, 3)).toBe(70);
    expect(completenessRate(5, 8)).toBe(0);
  });

  test("classifyEmployeeGaps flags missing register, placement, identity, failed events, and ending contracts", () => {
    const e = emp({
      id: "emp-gap",
      legal_entity_id: "ent-2",
      workplace_id: null,
      org_unit_id: null,
      job: null,
      hire_date: null,
      home_branch_review_required: true,
      identity_review_required: true,
      register_review_required: true,
      contract_end_date: "2026-12-01",
      failed_event: { id: "ev-1", event_type: "TRANSFER", effective_date: "2026-11-01", failure_code: "conflict" },
    });
    const fact: Fact = {
      employee_id: "emp-gap",
      updated_at: "2026-11-01T00:00:00Z",
      sex: null,
      address: null,
      careers: [],
      exit_reason_code: null,
      exit_reason_label: null,
      register_note: null,
      birth_date: null,
    };

    expect(classifyEmployeeGaps(e, fact, "2026-12-15")).toEqual([
      "birth",
      "sex",
      "address",
      "career",
      "job",
      "hire",
      "unplaced",
      "identity",
      "failed",
      "contractSoon",
    ]);
  });

  test("buildHealthRows keeps view-only register_review_required employees without fabricating field causes", () => {
    const e = emp({ id: "emp-view", register_review_required: true });
    const rows = buildHealthRows([e], new Map(), "2026-12-15");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.registerOnly).toBe(true);
    expect(rows[0]!.kpis).toEqual(["register"]);
    expect(rows[0]!.categories).toEqual([]);
  });

  test("buildCategorySummaries and filterHealthRows combine KPI buckets, entity filter, and category filter", () => {
    const a = emp({ id: "a", legal_entity_id: "ent-1", register_review_required: true });
    const b = emp({ id: "b", legal_entity_id: "ent-2", org_unit_id: null });
    const facts = new Map<string, Fact>([
      ["a", { employee_id: "a", updated_at: "2026-11-01T00:00:00Z", sex: "FEMALE", address: null, careers: [], exit_reason_code: null, exit_reason_label: null, register_note: null, birth_date: "1994-03-01" }],
    ]);
    const rows = buildHealthRows([a, b], facts, "2026-12-15");

    expect(filterHealthRows(rows, { kpi: "register", entityId: null, category: null }).map((r) => r.employee.id)).toEqual(["a"]);
    expect(filterHealthRows(rows, { kpi: "unplaced", entityId: "ent-2", category: "department" }).map((r) => r.employee.id)).toEqual(["b"]);

    const facets: EmployeeFacets = {
      total: 10,
      status: [],
      employment_type: [],
      legal_entity: [],
      workplace: [],
      review: {
        department_missing: 1,
        identity_review_required: 0,
        register_review_required: 1,
        home_branch_review_required: 0,
        lifecycle_apply_failed: 0,
        contract_ended: 0,
        contract_ending_before: 0,
      },
    };
    const summaries = buildCategorySummaries({
      totalActive: 10,
      facets,
      employees: [a, b],
      factsById: facts,
      soonCutoff: "2026-12-15",
      canReadRegisterFacts: true,
    });
    expect(summaries.find((s) => s.id === "address")?.missing).toBe(1);
    expect(summaries.find((s) => s.id === "address")?.rate).toBe(90);
    expect(kpiCounts(rows, facets)).toMatchObject({ all: 2, register: 1, unplaced: 1, identity: 0, actionsContracts: 0 });
  });

  test("kpiCounts preserves explicit zero server facet counts even when rows contain gaps", () => {
    const rowWithGaps = buildHealthRows(
      [emp({ id: "emp-zero-facets", org_unit_id: null, contract_end_date: "2026-12-01" })],
      new Map(),
      "2026-12-15",
    );
    const zeroFacets: EmployeeFacets = {
      total: 1,
      status: [],
      employment_type: [],
      legal_entity: [],
      workplace: [],
      review: {
        department_missing: 0,
        identity_review_required: 0,
        register_review_required: 0,
        home_branch_review_required: 0,
        lifecycle_apply_failed: 0,
        contract_ended: 0,
        contract_ending_before: 0,
      },
    };
    expect(kpiCounts(rowWithGaps, zeroFacets)).toEqual({
      all: 1,
      register: 0,
      unplaced: 0,
      identity: 0,
      actionsContracts: 0,
    });
  });
});

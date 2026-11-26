// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, describe, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { CHOSUNG, filterConsoleRows, missingLabel, type EmpType } from "./roster-console-data";

type Employee = components["schemas"]["Employee"];

beforeAll(() => loadCatalog("ko"));

function makeEmployee(overrides: Partial<Employee>): Employee {
  return {
    id: "emp-1",
    company: "Test Corp",
    name: "Alice",
    employee_number: "10587",
    org_unit_id: null,
    legal_entity_id: null,
    workplace_id: null,
    status: "ACTIVE",
    employment_type: "REGULAR",
    register_review_required: false,
    home_branch_review_required: false,
    identity_resolution_strategy: "employee_number",
    identity_resolution_confidence: "high",
    identity_review_required: false,
    identity_name_only_merge: false,
    next_event: null,
    failed_event: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("missingLabel", () => {
  test("a register gap is tagged as one, never as a named item the row does not carry", () => {
    expect(missingLabel(makeEmployee({ register_review_required: true }))).toBe(t("people.missing.register"));
    expect(missingLabel(makeEmployee({ identity_review_required: true }))).toBe(t("people.identityReview"));
    expect(missingLabel(makeEmployee({ employment_type: undefined }))).toBe(t("roster.type.missing"));
    expect(missingLabel(makeEmployee({}))).toBeNull();
  });
});

describe("filterConsoleRows", () => {
  const baseFilter = {
    empTypes: new Set<EmpType>(),
    activeChosung: null as string | null,
  };

  test("filters by empTypes and Hangul chosung", () => {
    const rows = [
      makeEmployee({ id: "1", name: t("enum.employmentType.CONTRACT"), employment_type: "CONTRACT", register_review_required: true }),
      makeEmployee({ id: "2", name: t("people.col.number"), employment_type: "PART_TIME", register_review_required: false }),
      makeEmployee({ id: "3", name: t("roster.status.ON_LEAVE"), employment_type: "REGULAR", register_review_required: true }),
      makeEmployee({ id: "4", name: "Alice", employment_type: "REGULAR", register_review_required: false }),
    ];

    expect(filterConsoleRows(rows, { ...baseFilter, empTypes: new Set<EmpType>(["CONTRACT"]) }).map(r => r.id)).toEqual(["1"]);
    expect(filterConsoleRows(rows, { ...baseFilter, activeChosung: CHOSUNG[0]! }).map(r => r.id)).toEqual(["1"]);
    expect(filterConsoleRows(rows, { ...baseFilter, activeChosung: CHOSUNG[6]! }).map(r => r.id)).toEqual(["2"]);
    expect(filterConsoleRows(rows, { ...baseFilter, activeChosung: CHOSUNG[13]! }).map(r => r.id)).toEqual(["3"]);
  });
});

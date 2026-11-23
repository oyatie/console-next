// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, describe, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { CHOSUNG, filterConsoleRows, type EmpType } from "./roster-console-data";

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

describe("filterConsoleRows", () => {
  const baseFilter = {
    empTypes: new Set<EmpType>(),
    addressMissingOnly: false,
    probationOnly: false,
    activeChosung: null as string | null,
  };

  test("probationOnly keeps only PROMOTE next_event rows and excludes TRANSFER and null", () => {
    const rows = [
      makeEmployee({ id: "1", name: "Transfer Person", next_event: { id: "e1", event_type: "TRANSFER", effective_date: "2026-12-01" } }),
      makeEmployee({ id: "2", name: "Promote Person", next_event: { id: "e2", event_type: "PROMOTE", effective_date: "2026-12-01" } }),
      makeEmployee({ id: "3", name: "No Event Person", next_event: null }),
    ];

    expect(filterConsoleRows(rows, { ...baseFilter, probationOnly: true }).map(r => r.id)).toEqual(["2"]);
    expect(filterConsoleRows(rows, { ...baseFilter, probationOnly: false }).map(r => r.id)).toEqual(["1", "2", "3"]);
  });

  test("filters by empTypes, addressMissingOnly, and Hangul chosung", () => {
    const rows = [
      makeEmployee({ id: "1", name: t("enum.employmentType.CONTRACT"), employment_type: "CONTRACT", register_review_required: true }),
      makeEmployee({ id: "2", name: t("people.col.number"), employment_type: "PART_TIME", register_review_required: false }),
      makeEmployee({ id: "3", name: t("roster.status.ON_LEAVE"), employment_type: "REGULAR", register_review_required: true }),
      makeEmployee({ id: "4", name: "Alice", employment_type: "REGULAR", register_review_required: false }),
    ];

    expect(filterConsoleRows(rows, { ...baseFilter, empTypes: new Set<EmpType>(["CONTRACT"]) }).map(r => r.id)).toEqual(["1"]);
    expect(filterConsoleRows(rows, { ...baseFilter, addressMissingOnly: true }).map(r => r.id)).toEqual(["1", "3"]);
    expect(filterConsoleRows(rows, { ...baseFilter, activeChosung: CHOSUNG[0]! }).map(r => r.id)).toEqual(["1"]);
    expect(filterConsoleRows(rows, { ...baseFilter, activeChosung: CHOSUNG[6]! }).map(r => r.id)).toEqual(["2"]);
    expect(filterConsoleRows(rows, { ...baseFilter, activeChosung: CHOSUNG[13]! }).map(r => r.id)).toEqual(["3"]);
  });
});

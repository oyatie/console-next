// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import {
  buildTeamQueryParams,
  daysUntilDate,
  deriveTeamScopes,
  filterTeamEmployees,
  filterVisibleTeamLeaves,
  type TeamEmployee,
  type TeamLeaveRequest,
} from "./team-scope";

const baseEmp = (over: Partial<TeamEmployee> = {}): TeamEmployee => ({
  id: "e1",
  company: "Saeon",
  name: "Kim",
  employee_number: "1001",
  org_unit_id: "u1",
  legal_entity_id: "le1",
  workplace_id: "w1",
  org_unit: "Prod Team 1",
  position: "Lead",
  status: "ACTIVE",
  hire_date: "2020-01-01",
  employment_type: "REGULAR",
  home_branch_review_required: false,
  identity_resolution_strategy: "employee_number",
  identity_resolution_confidence: "high",
  identity_review_required: false,
  identity_name_only_merge: false,
  next_event: null,
  failed_event: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

test("deriveTeamScopes derives concurrent scopes strictly from enforced hr_basic grants", () => {
  const scopes = deriveTeamScopes(
    {
      account_id: "u1",
      is_ops: false,
      phase: "OPERATING",
      as_of: "2026-11-10T00:00:00Z",
      entries: [
        {
          grant_id: "g1",
          role_id: "r1",
          role_name_ko: "Team",
          domain: "hr_basic",
          level: "view",
          enforcement: "ENFORCED",
          valid_from: "2026-01-01T00:00:00Z",
          scope: { kind: "DEPARTMENT", node_id: "d1", node_name: "Team 1", include_descendants: true },
          caveats: [],
        },
        {
          grant_id: "g2",
          role_id: "r1",
          role_name_ko: "Team",
          domain: "hr_basic",
          level: "view",
          enforcement: "ENFORCED",
          valid_from: "2026-01-01T00:00:00Z",
          scope: { kind: "WORKPLACE", node_id: "w2", node_name: "Plant 2", include_descendants: true },
          caveats: [],
        },
        {
          grant_id: "g3",
          role_id: "r2",
          role_name_ko: "Revoked",
          domain: "hr_basic",
          level: "view",
          enforcement: "REVOKED",
          valid_from: "2026-01-01T00:00:00Z",
          scope: { kind: "DEPARTMENT", node_id: "d3", node_name: "Revoked", include_descendants: true },
          caveats: [],
        },
      ],
    },
    { employee_org_unit: "Team 1", employee_org_unit_id: "d1" } as never,
  );
  expect(scopes.hasTenantWide).toBe(false);
  expect(scopes.hasConcurrent).toBe(true);
  expect(scopes.concurrentScopes).toEqual([
    { id: "d1", kind: "DEPARTMENT", name: "Team 1" },
    { id: "w2", kind: "WORKPLACE", name: "Plant 2" },
  ]);
  expect(scopes.directUnitId).toBe("d1");
});

test("buildTeamQueryParams maps concurrent node kinds to exact employee filters", () => {
  expect(
    buildTeamQueryParams({
      view: "concurrent",
      today: "2026-11-10",
      selectedScope: { id: "d1", kind: "DEPARTMENT", name: "Team 1" },
      statusFilter: "ACTIVE",
      search: "Kim",
    }),
  ).toMatchObject({ org_unit_id: "d1", status: "ACTIVE", search: "Kim" });

  expect(
    buildTeamQueryParams({
      view: "concurrent",
      today: "2026-11-10",
      selectedScope: { id: "w2", kind: "WORKPLACE", name: "Plant 2" },
      statusFilter: "MISSING",
    }),
  ).toMatchObject({ workplace_id: "w2", team_review_required: true });
});

test("filterTeamEmployees filters direct unit, soon events, and missing review rows", () => {
  const rows = [
    baseEmp({ id: "e1", org_unit_id: "d1", org_unit: "Sales", contract_end_date: "2026-11-20", next_event: { id: "ev1", event_type: "CONTRACT_RENEWAL", effective_date: "2026-11-20" } }),
    baseEmp({ id: "e2", org_unit_id: "d2", org_unit: "Sales", identity_review_required: true, next_event: { id: "ev2", event_type: "TRANSFER", effective_date: "2026-11-11" } }),
  ];
  expect(filterTeamEmployees(rows, { view: "direct", directUnitId: "d1", statusFilter: "all", today: "2026-11-10" }).map(r => r.id)).toEqual(["e1"]);
  expect(filterTeamEmployees(rows, { view: "direct", directUnitId: null, statusFilter: "all", today: "2026-11-10" })).toEqual([]);
  expect(filterTeamEmployees(rows, { view: "all", directUnitId: null, statusFilter: "SOON", today: "2026-11-10" }).map(r => r.id)).toEqual(["e1"]);
  expect(filterTeamEmployees(rows, { view: "all", directUnitId: null, statusFilter: "MISSING", today: "2026-11-10" }).map(r => r.id)).toEqual(["e2"]);
  expect(daysUntilDate("2026-11-20", "2026-11-10")).toBe(10);
});

test("filterVisibleTeamLeaves excludes pending leaves outside the visible concurrent scope", () => {
  const leaves = [
    { id: "l1", subject_employee_id: "e1" },
    { id: "l2", subject_employee_id: "e2" },
  ] as TeamLeaveRequest[];
  const visible = new Set(["e2"]);
  expect(filterVisibleTeamLeaves(leaves, visible, true).map(l => l.id)).toEqual(["l2"]);
  expect(filterVisibleTeamLeaves(leaves, visible, false).map(l => l.id)).toEqual(["l1", "l2"]);
});

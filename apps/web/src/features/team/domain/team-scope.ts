// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { addDays, daysBetween, isDate } from "../../../ui/date/days";

type S = components["schemas"];
export type TeamEmployee = S["Employee"];
export type TeamLeaveRequest = S["LeaveRequestV2View"];

type TeamScopeNode = {
  id: string;
  kind: string;
  name: string;
};

type TeamScopeSummary = {
  hasTenantWide: boolean;
  hasConcurrent: boolean;
  concurrentScopes: readonly TeamScopeNode[];
  directUnitId: string | null;
};

/** Derives team lenses strictly from enforced Cedar `hr_basic` grants (zero hard-coded manager roles). */
export function deriveTeamScopes(
  access: S["AccessEffective"] | undefined,
  me: S["CurrentUser"] | undefined,
): TeamScopeSummary {
  const entries = (access?.entries ?? []).filter(
    entry => entry.domain === "hr_basic" && entry.enforcement === "ENFORCED",
  );
  const hasTenantWide = Boolean(access?.is_ops || entries.some(entry => entry.scope.kind === "TENANT"));
  const seen = new Map<string, TeamScopeNode>();
  for (const entry of entries) {
    if (entry.scope.kind === "TENANT" || !entry.scope.node_id) continue;
    if (!seen.has(entry.scope.node_id)) {
      seen.set(entry.scope.node_id, {
        id: entry.scope.node_id,
        kind: entry.scope.kind,
        name: entry.scope.node_name ?? entry.scope.node_id,
      });
    }
  }
  const concurrentScopes = [...seen.values()];
  return {
    hasTenantWide,
    hasConcurrent: concurrentScopes.length > 1,
    concurrentScopes,
    directUnitId: me?.employee_org_unit_id || null,
  };
}

/** Computes remaining days until a target date, or null if absent/invalid. */
export function daysUntilDate(targetDate: string | null | undefined, today: string): number | null {
  if (!targetDate || !isDate(targetDate) || !isDate(today)) return null;
  return daysBetween(today, targetDate);
}

/** Filters loaded team rows for direct-unit, ending-soon, or missing-info views. */
export function filterTeamEmployees(
  rows: readonly TeamEmployee[],
  {
    view,
    directUnitId,
    statusFilter,
    today,
  }: {
    view: "all" | "direct" | "concurrent";
    directUnitId: string | null;
    statusFilter: "all" | "ACTIVE" | "ON_LEAVE" | "SOON" | "MISSING";
    today: string;
  },
): TeamEmployee[] {
  return rows.filter(row => {
    if (view === "direct" && (!directUnitId || (row.org_unit_id ?? row.org_unit) !== directUnitId)) {
      return false;
    }
    if (statusFilter === "SOON") {
      const days = daysUntilDate(row.contract_end_date, today);
      if (days === null || days < 0 || days > 30) return false;
    }
    if (statusFilter === "MISSING") {
      if (!row.register_review_required && !row.identity_review_required && row.employment_type) {
        return false;
      }
    }
    return true;
  });
}

/** Builds Cedar-safe query params for `GET /api/v1/employees` without calling `org-structure`. */
export function buildTeamQueryParams({
  view,
  selectedScope,
  directUnitId,
  today,
  statusFilter,
  search,
  sort,
}: {
  view: "all" | "direct" | "concurrent";
  selectedScope?: TeamScopeNode;
  directUnitId?: string | null;
  today: string;
  statusFilter: "all" | "ACTIVE" | "ON_LEAVE" | "SOON" | "MISSING";
  search?: string;
  sort?: string;
}) {
  const scopeParams =
    view === "direct" && directUnitId
      ? { org_unit_id: directUnitId }
      : view === "concurrent" && selectedScope
      ? selectedScope.kind === "LEGAL_ENTITY"
        ? { legal_entity_id: selectedScope.id }
        : selectedScope.kind === "WORKPLACE"
          ? { workplace_id: selectedScope.id }
          : { org_unit_id: selectedScope.id }
      : {};
  return {
    ...scopeParams,
    status: statusFilter === "ACTIVE" || statusFilter === "ON_LEAVE" ? statusFilter : undefined,
    team_review_required: statusFilter === "MISSING" || undefined,
    ...(statusFilter === "SOON" ? contractWindow(today) : {}),
    search: search?.trim() || undefined,
    sort: sort || "name",
    limit: 100,
  };
}

export const contractWindow = (today: string) => ({
  contract_ending_on_or_after: today,
  contract_ending_before: addDays(today, 31),
});

/** Filters pending leave requests to visible rows when a client-side or concurrent scope filter is active. */
export function filterVisibleTeamLeaves(
  leaves: readonly TeamLeaveRequest[],
  visibleEmployeeIds: ReadonlySet<string>,
  restrictToVisible: boolean,
): readonly TeamLeaveRequest[] {
  return restrictToVisible ? leaves.filter(req => visibleEmployeeIds.has(req.subject_employee_id)) : leaves;
}

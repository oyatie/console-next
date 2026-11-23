// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { daysBetween, isDate } from "../../../ui/date/days";

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
  directUnitName: string | null;
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
    directUnitName: me?.employee_org_unit?.trim() || null,
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
    directUnitName,
    statusFilter,
    today,
  }: {
    view: "all" | "direct" | "concurrent";
    directUnitName: string | null;
    statusFilter: "all" | "ACTIVE" | "ON_LEAVE" | "SOON" | "MISSING";
    today: string;
  },
): TeamEmployee[] {
  return rows.filter(row => {
    if (view === "direct" && (!directUnitName || row.org_unit !== directUnitName)) {
      return false;
    }
    if (statusFilter === "SOON") {
      const days = daysUntilDate(row.next_event?.effective_date, today);
      if (days === null || days > 30) return false;
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
  statusFilter,
  search,
  sort,
}: {
  view: "all" | "direct" | "concurrent";
  selectedScope?: TeamScopeNode;
  statusFilter: "all" | "ACTIVE" | "ON_LEAVE" | "SOON" | "MISSING";
  search?: string;
  sort?: string;
}) {
  const scopeParams =
    view === "concurrent" && selectedScope
      ? selectedScope.kind === "LEGAL_ENTITY"
        ? { legal_entity_id: selectedScope.id }
        : selectedScope.kind === "WORKPLACE"
          ? { workplace_id: selectedScope.id }
          : { org_unit_id: selectedScope.id }
      : {};
  return {
    ...scopeParams,
    status: statusFilter === "ACTIVE" || statusFilter === "ON_LEAVE" ? statusFilter : undefined,
    register_review_required: statusFilter === "MISSING" ? true : undefined,
    search: search?.trim() || undefined,
    sort: sort || "name",
    limit: 100,
  };
}

/** Computes team StatRow and StatusBar counts, reflecting client-side filters when active. */
export function computeTeamStats({
  rows,
  visibleLeaves,
  facets,
  pagesTotal,
  isClientFiltered,
  today,
}: {
  rows: readonly TeamEmployee[];
  visibleLeaves: readonly TeamLeaveRequest[];
  facets: S["EmployeeFacets"] | undefined;
  pagesTotal: number | undefined;
  isClientFiltered: boolean;
  today: string;
}) {
  const totalCount = isClientFiltered ? rows.length : (facets?.total ?? pagesTotal ?? rows.length);
  const activeCount = isClientFiltered
    ? rows.filter(r => r.status === "ACTIVE").length
    : (facets?.status.find(s => s.value === "ACTIVE")?.count ?? rows.filter(r => r.status === "ACTIVE").length);
  const onLeaveCount = isClientFiltered
    ? rows.filter(r => r.status === "ON_LEAVE").length
    : (facets?.status.find(s => s.value === "ON_LEAVE")?.count ?? rows.filter(r => r.status === "ON_LEAVE").length);
  const contractEndingCount = isClientFiltered
    ? rows.filter(r => {
        const days = daysUntilDate(r.next_event?.effective_date, today);
        return days !== null && days <= 30;
      }).length
    : (facets?.review.contract_ending_before ?? 0);
  return {
    totalCount,
    activeCount,
    onLeaveCount,
    contractEndingCount,
    attentionCount: visibleLeaves.length + contractEndingCount,
  };
}

/** Filters pending leave requests to visible rows when a client-side or concurrent scope filter is active. */
export function filterVisibleTeamLeaves(
  leaves: readonly TeamLeaveRequest[],
  visibleEmployeeIds: ReadonlySet<string>,
  restrictToVisible: boolean,
): readonly TeamLeaveRequest[] {
  return restrictToVisible ? leaves.filter(req => visibleEmployeeIds.has(req.subject_employee_id)) : leaves;
}

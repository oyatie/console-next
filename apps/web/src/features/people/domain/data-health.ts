// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "@console/api/schema";

export type DataHealthCategory = NonNullable<
  NonNullable<paths["/api/v1/hr/people/data-health"]["get"]["parameters"]["query"]>["category"]
>;
export type PeopleDataHealthResponse = components["schemas"]["PeopleDataHealthResponse"];
type DataHealthDrilldownRaw = PeopleDataHealthResponse["drilldown_items"][number];

export type KpiBucket = "all" | "register" | "unplaced" | "identity" | "actionsContracts";

export const DATA_HEALTH_CATEGORIES: readonly DataHealthCategory[] = [
  "birth",
  "sex",
  "address",
  "career",
  "job",
  "hire",
  "contractEnd",
  "register_incomplete",
  "rrn_missing",
  "unplaced",
  "department_missing",
  "bank_account_missing",
  "identity_review",
  "failed_action",
];

type CategoryDestination = "roster" | "unplaced" | "grid";

export type CategorySummary = {
  id: DataHealthCategory;
  kpi: Exclude<KpiBucket, "all">;
  missing: number;
  total: number;
  rate: number;
  destination: CategoryDestination;
  rosterReview?: "register" | "unplaced" | "department" | "identity" | "failed" | "contractSoon";
  drilldownIds?: readonly string[];
};

export type DrilldownItem = {
  employeeId: string;
  employeeNumber?: string;
  label: string;
  employmentStatus: DataHealthDrilldownRaw["employment_status"];
  missingCategories: readonly string[];
  unplacedKind: "workplace" | "department" | null;
};

export function completenessRate(total: number, missing: number): number {
  if (total <= 0) return 100;
  const clampedMissing = Math.max(0, missing);
  if (clampedMissing === 0) return 100;
  const filled = Math.max(0, total - clampedMissing);
  return Math.max(0, Math.min(99, Math.floor((filled / total) * 100)));
}

export function kpiCategory(kpi: KpiBucket, data?: PeopleDataHealthResponse): DataHealthCategory | null {
  switch (kpi) {
    case "all":
      return null;
    case "register":
      return "register_incomplete";
    case "unplaced":
      return data && data.placement_summary.unplaced === 0 && data.placement_summary.department_missing > 0
        ? "department_missing"
        : "unplaced";
    case "identity":
      return data && data.id_summary.missing === 0 && data.identity_review.needs_review > 0
        ? "identity_review"
        : "rrn_missing";
    case "actionsContracts":
      return data && data.failed_actions.count === 0 && data.bank_account.missing > 0
        ? "bank_account_missing"
        : "failed_action";
  }
}

export function kpiSummary(data: PeopleDataHealthResponse): Record<KpiBucket, number> {
  return {
    all: data.cohort.total,
    register: data.statutory_register.incomplete_count,
    unplaced: data.placement_summary.unplaced + data.placement_summary.department_missing,
    identity: data.id_summary.missing + data.id_summary.not_issued + data.identity_review.needs_review,
    actionsContracts: data.failed_actions.count + data.bank_account.missing,
  };
}

export function buildCategorySummaries(data: PeopleDataHealthResponse): CategorySummary[] {
  const total = Math.max(0, data.cohort.total);
  const reg = data.statutory_register.missing_by_category;
  const idsFor = (cat: DataHealthCategory) =>
    data.drilldown_items
      .filter((item) => item.missing_categories.includes(cat))
      .map((item) => item.employee_id);

  const specs: Omit<CategorySummary, "rate">[] = [
    { id: "birth", kpi: "register", missing: reg.birth, total, destination: "grid", rosterReview: "register" },
    { id: "sex", kpi: "register", missing: reg.sex, total, destination: "grid", rosterReview: "register" },
    { id: "address", kpi: "register", missing: reg.address, total, destination: "grid", rosterReview: "register" },
    { id: "career", kpi: "register", missing: reg.career, total, destination: "roster", rosterReview: "register" },
    { id: "job", kpi: "register", missing: reg.job, total, destination: "grid", rosterReview: "register" },
    { id: "hire", kpi: "register", missing: reg.hire, total, destination: "roster", rosterReview: "register" },
    { id: "contractEnd", kpi: "register", missing: reg.contract_end, total, destination: "roster", rosterReview: "contractSoon" },
    { id: "register_incomplete", kpi: "register", missing: data.statutory_register.incomplete_count, total, destination: "roster", rosterReview: "register" },
    { id: "rrn_missing", kpi: "identity", missing: data.id_summary.missing, total, destination: "roster", drilldownIds: idsFor("rrn_missing") },
    { id: "unplaced", kpi: "unplaced", missing: data.placement_summary.unplaced, total, destination: "unplaced", rosterReview: "unplaced" },
    { id: "department_missing", kpi: "unplaced", missing: data.placement_summary.department_missing, total, destination: "unplaced", rosterReview: "department" },
    { id: "bank_account_missing", kpi: "actionsContracts", missing: data.bank_account.missing, total, destination: "roster", drilldownIds: idsFor("bank_account_missing") },
    { id: "identity_review", kpi: "identity", missing: data.identity_review.needs_review, total, destination: "roster", rosterReview: "identity" },
    { id: "failed_action", kpi: "actionsContracts", missing: data.failed_actions.count, total, destination: "roster", rosterReview: "failed" },
  ];

  return specs.map((item) => ({ ...item, rate: completenessRate(item.total, item.missing) }));
}

export function mapDrilldownItems(data: PeopleDataHealthResponse): DrilldownItem[] {
  return data.drilldown_items.map((item) => ({
    employeeId: item.employee_id,
    employeeNumber: item.employee_number,
    label: `#${item.employee_number ?? item.employee_id.slice(0, 8)}`,
    employmentStatus: item.employment_status,
    missingCategories: item.missing_categories,
    unplacedKind: item.missing_categories.includes("unplaced")
      ? "workplace"
      : item.missing_categories.includes("department_missing")
        ? "department"
        : null,
  }));
}

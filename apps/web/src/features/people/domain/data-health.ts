// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

type Employee = components["schemas"]["Employee"];
type EmployeeFacets = components["schemas"]["EmployeeFacets"];
type RegisterFactsQueryItem = components["schemas"]["RegisterFactsQueryItem"];

export type KpiBucket = "all" | "register" | "unplaced" | "identity" | "actionsContracts";

export type HealthCategoryId =
  | "birth"
  | "sex"
  | "address"
  | "career"
  | "job"
  | "hire"
  | "unplaced"
  | "department"
  | "identity"
  | "failed"
  | "contractSoon";

type CategoryDestination = "roster" | "unplaced" | "grid";

export type CategorySummary = {
  id: HealthCategoryId;
  kpi: Exclude<KpiBucket, "all">;
  missing: number;
  total: number;
  rate: number;
  destination: CategoryDestination;
  rosterReview?: "register" | "unplaced" | "department" | "identity" | "failed" | "contractSoon";
};

export type HealthEmployeeRow = {
  employee: Employee;
  categories: readonly HealthCategoryId[];
  kpis: readonly Exclude<KpiBucket, "all">[];
  registerOnly: boolean;
  contractSoon: boolean;
  unplacedKind: "workplace" | "department" | null;
};

export function completenessRate(total: number, missing: number): number {
  if (total <= 0) return 100;
  const filled = Math.max(0, total - Math.max(0, missing));
  return Math.max(0, Math.min(100, Math.round((filled / total) * 100)));
}

export function classifyEmployeeGaps(
  e: Employee,
  fact: RegisterFactsQueryItem | undefined,
  soonCutoff: string,
): HealthCategoryId[] {
  const out: HealthCategoryId[] = [];
  if (fact) {
    if (!fact.birth_date) out.push("birth");
    if (!fact.sex) out.push("sex");
    if (!fact.address) out.push("address");
    if (!fact.careers || fact.careers.length === 0) out.push("career");
  }
  if (!e.job) out.push("job");
  if (!e.hire_date) out.push("hire");
  if (e.home_branch_review_required || !e.workplace_id) out.push("unplaced");
  else if (!e.org_unit_id && !e.org_unit) out.push("department");
  if (e.identity_review_required) out.push("identity");
  if (e.failed_event) out.push("failed");
  if (e.contract_end_date && e.contract_end_date <= soonCutoff) out.push("contractSoon");
  return out;
}

function employeeKpis(
  e: Employee,
  categories: readonly HealthCategoryId[],
): Exclude<KpiBucket, "all">[] {
  const kpis = new Set<Exclude<KpiBucket, "all">>();
  if (
    e.register_review_required ||
    categories.some((c) => c === "birth" || c === "sex" || c === "address" || c === "career" || c === "job" || c === "hire")
  ) {
    kpis.add("register");
  }
  if (
    e.home_branch_review_required ||
    !e.workplace_id ||
    (!e.org_unit_id && !e.org_unit) ||
    categories.includes("unplaced") ||
    categories.includes("department")
  ) {
    kpis.add("unplaced");
  }
  if (e.identity_review_required || categories.includes("identity")) {
    kpis.add("identity");
  }
  if (Boolean(e.failed_event) || categories.includes("failed") || categories.includes("contractSoon")) {
    kpis.add("actionsContracts");
  }
  return [...kpis];
}

export function buildHealthRows(
  employees: readonly Employee[],
  factsById: ReadonlyMap<string, RegisterFactsQueryItem>,
  soonCutoff: string,
): HealthEmployeeRow[] {
  const rows: HealthEmployeeRow[] = [];
  for (const employee of employees) {
    const fact = factsById.get(employee.id);
    const categories = classifyEmployeeGaps(employee, fact, soonCutoff);
    const kpis = employeeKpis(employee, categories);
    if (kpis.length === 0 && categories.length === 0) continue;
    rows.push({
      employee,
      categories,
      kpis,
      registerOnly: Boolean(employee.register_review_required) && !fact,
      contractSoon: categories.includes("contractSoon"),
      unplacedKind: categories.includes("unplaced")
        ? "workplace"
        : categories.includes("department")
          ? "department"
          : null,
    });
  }
  return rows;
}

export function buildCategorySummaries({
  totalActive,
  facets,
  employees,
  factsById,
  soonCutoff,
  canReadRegisterFacts,
}: {
  totalActive: number;
  facets: EmployeeFacets | undefined;
  employees: readonly Employee[];
  factsById: ReadonlyMap<string, RegisterFactsQueryItem>;
  soonCutoff: string;
  canReadRegisterFacts: boolean;
}): CategorySummary[] {
  const total = Math.max(totalActive, employees.length);
  const countEmp = (pred: (e: Employee, f?: RegisterFactsQueryItem) => boolean) =>
    employees.reduce((n, e) => n + (pred(e, factsById.get(e.id)) ? 1 : 0), 0);

  const registerFallback = facets?.review.register_review_required ?? countEmp((e) => Boolean(e.register_review_required));
  const birthMissing = canReadRegisterFacts ? countEmp((_, f) => Boolean(f && !f.birth_date)) : registerFallback;
  const sexMissing = canReadRegisterFacts ? countEmp((_, f) => Boolean(f && !f.sex)) : registerFallback;
  const addressMissing = canReadRegisterFacts ? countEmp((_, f) => Boolean(f && !f.address)) : registerFallback;
  const careerMissing = canReadRegisterFacts ? countEmp((_, f) => Boolean(f && (!f.careers || f.careers.length === 0))) : registerFallback;
  const jobMissing = countEmp((e) => !e.job);
  const hireMissing = countEmp((e) => !e.hire_date);
  const unplacedMissing = facets?.review.home_branch_review_required ?? countEmp((e) => e.home_branch_review_required || !e.workplace_id);
  const deptMissing = facets?.review.department_missing ?? countEmp((e) => !e.home_branch_review_required && !e.org_unit_id && !e.org_unit);
  const identityMissing = facets?.review.identity_review_required ?? countEmp((e) => e.identity_review_required);
  const failedMissing = facets?.review.lifecycle_apply_failed ?? countEmp((e) => Boolean(e.failed_event));
  const contractSoonMissing =
    facets?.review.contract_ending_before ??
    facets?.review.contract_ended ??
    countEmp((e) => Boolean(e.contract_end_date && e.contract_end_date <= soonCutoff));

  const specs: Omit<CategorySummary, "rate">[] = [
    { id: "birth", kpi: "register", missing: birthMissing, total, destination: "grid", rosterReview: "register" },
    { id: "sex", kpi: "register", missing: sexMissing, total, destination: "grid", rosterReview: "register" },
    { id: "address", kpi: "register", missing: addressMissing, total, destination: "grid", rosterReview: "register" },
    { id: "career", kpi: "register", missing: careerMissing, total, destination: "roster", rosterReview: "register" },
    { id: "job", kpi: "register", missing: jobMissing, total, destination: "grid", rosterReview: "register" },
    { id: "hire", kpi: "register", missing: hireMissing, total, destination: "roster", rosterReview: "register" },
    { id: "unplaced", kpi: "unplaced", missing: unplacedMissing, total, destination: "unplaced", rosterReview: "unplaced" },
    { id: "department", kpi: "unplaced", missing: deptMissing, total, destination: "unplaced", rosterReview: "department" },
    { id: "identity", kpi: "identity", missing: identityMissing, total, destination: "roster", rosterReview: "identity" },
    { id: "failed", kpi: "actionsContracts", missing: failedMissing, total, destination: "roster", rosterReview: "failed" },
    { id: "contractSoon", kpi: "actionsContracts", missing: contractSoonMissing, total, destination: "roster", rosterReview: "contractSoon" },
  ];

  return specs.map((item) => ({ ...item, rate: completenessRate(item.total, item.missing) }));
}

export function filterHealthRows(
  rows: readonly HealthEmployeeRow[],
  filters: {
    kpi: KpiBucket;
    entityId: string | null;
    category: HealthCategoryId | null;
  },
): HealthEmployeeRow[] {
  return rows.filter((row) => {
    if (filters.kpi !== "all" && !row.kpis.includes(filters.kpi)) return false;
    if (filters.entityId && row.employee.legal_entity_id !== filters.entityId) return false;
    if (filters.category && !row.categories.includes(filters.category)) return false;
    return true;
  });
}

export function kpiCounts(
  rows: readonly HealthEmployeeRow[],
  facets: EmployeeFacets | undefined,
): Record<KpiBucket, number> {
  const register = facets?.review.register_review_required ?? rows.filter((r) => r.kpis.includes("register")).length;
  const unplaced =
    (facets?.review ? (facets.review.home_branch_review_required ?? 0) + (facets.review.department_missing ?? 0) : undefined) ??
    rows.filter((r) => r.kpis.includes("unplaced")).length;
  const identity = facets?.review.identity_review_required ?? rows.filter((r) => r.kpis.includes("identity")).length;
  const actionsContracts =
    (facets?.review
      ? (facets.review.lifecycle_apply_failed ?? 0) + (facets.review.contract_ending_before ?? facets.review.contract_ended ?? 0)
      : undefined) ?? rows.filter((r) => r.kpis.includes("actionsContracts")).length;
  return {
    all: rows.length,
    register,
    unplaced,
    identity,
    actionsContracts,
  };
}

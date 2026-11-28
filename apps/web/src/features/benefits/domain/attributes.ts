// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

type Item = components["schemas"]["BenefitCatalogItem"];
type Edit = components["schemas"]["BenefitCatalogUpdateRequest"];

export const numbers = [
  ["coveredCount", "covered_count", "benefits.coveredCount", 2_147_483_647],
  ["estimatedAnnualCostWon", "estimated_annual_cost_won", "benefits.annualCost", Number.MAX_SAFE_INTEGER],
  ["employerRateBps", "employer_rate_bps", "benefits.employerRate", 10_000],
] as const;

export function changedAttributes(values: { get(key: string): unknown }, item?: Item) {
  const result: Pick<Edit, "coveredCount" | "estimatedAnnualCostWon" | "employerRateBps" | "legalBasis"> = {};
  for (const [name, key] of numbers) {
    const value = values.get(name);
    if (typeof value === "string" && value !== String(item?.[key] ?? "")) result[name] = value ? Number(value) : null;
  }
  const basis = values.get("legalBasis");
  if (typeof basis === "string" && basis.trim() !== (item?.legal_basis ?? "")) result.legalBasis = basis.trim() || null;
  return result;
}

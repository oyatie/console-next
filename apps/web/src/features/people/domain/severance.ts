// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
type Package = components["schemas"]["EmployeeExitSettlementPackage"];
export type IneligibleSeverance = {
  reason: "UNDER_SERVICE_YEARS" | "UNDER_WEEKLY_HOURS";
  threshold: { num: number; den: number };
};

export function settlementOutcome(pkg?: Package | null): unknown {
  const eligibility = pkg?.statutory_basis?.severance_eligibility as { outcome?: unknown } | undefined;
  return eligibility === undefined ? undefined : eligibility?.outcome ?? null;
}

/** Eligibility and thresholds are the server's dated decision; never inferred from tenure or amounts. */
export function ineligibleSeverance(pkg?: Package | null): IneligibleSeverance | null {
  const eligibility = pkg?.statutory_basis?.severance_eligibility as { outcome?: unknown; reason?: unknown; threshold?: { num?: unknown; den?: unknown } } | undefined;
  if (eligibility?.outcome !== "NOT_ELIGIBLE") return null;
  const { reason, threshold } = eligibility;
  if (reason !== "UNDER_SERVICE_YEARS" && reason !== "UNDER_WEEKLY_HOURS") return null;
  const { num, den } = threshold ?? {};
  if (typeof num !== "number" || typeof den !== "number" || !Number.isSafeInteger(num) || !Number.isSafeInteger(den) || num <= 0 || den <= 0) return null;
  return { reason, threshold: { num, den } };
}

// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { trailGroup } from "./trail-group";

export const EXIT_LEGS = ["approval", "handover", "settlement", "access", "documents", "filing"] as const;
type ExitLeg = typeof EXIT_LEGS[number];
type ExitItem = components["schemas"]["LifecycleCaseItem"];
// NEEDS-BACKEND: the register supplies basis.exit_leg and basis.payroll_pending; absent metadata keeps the trail group.
export const exitLeg = (item: Pick<ExitItem, "kind" | "basis">): ExitLeg =>
  EXIT_LEGS.find(leg => leg === item.basis.exit_leg) ?? ({ documents: "documents", filing: "filing", payment: "settlement", access: "access", return: "access" } as const)[trailGroup(item.kind)];
export const exitPayrollPending = (item: Pick<ExitItem, "basis">) => item.basis.payroll_pending === true;
export const exitDeadlineKnown = (item: ExitItem) => item.due_date !== null && item.due_disposition !== "UNKNOWN" && item.due_disposition !== "HOLD" && item.status_code !== "LEGAL_REVIEW" && item.status_code !== "PRE_CONSOLE" && item.basis.legal_review_required !== true;
export const exitDeadlineSeverity = (days: number, dueSoonDays: number | null) => days < 0 ? "over" : dueSoonDays !== null && days <= dueSoonDays ? "due" : "far";
export const exitLegAtRisk = (items: readonly ExitItem[], dueSoonDays: number | null) => items.some(item =>
  ["OPEN", "BLOCKED", "PENDING_TRIGGER", "CORRECTION_NEEDED"].includes(item.status) && !exitPayrollPending(item) && exitDeadlineKnown(item) && item.due_in_days !== null && exitDeadlineSeverity(item.due_in_days, dueSoonDays) !== "far");

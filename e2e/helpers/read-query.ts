// SPDX-License-Identifier: LicenseRef-Proprietary
import { todayKst } from "../../apps/web/src/lib/pure/today";
import type { operations } from "@console/api/schema";

/** Supply valid inputs so protected-read probes reach authorization rather than query validation. */
export function readQuery(read: string, record: string): Record<string, string> {
  if (read.endsWith("/attendance/month")) return { month: todayKst().slice(0, 7) };
  if (read.endsWith("/attendance/days")) return { date: todayKst() };
  if (read.endsWith("/payslip-draft")) return { period: todayKst().slice(0, 7) } satisfies operations["getEmployeePayslipDraft"]["parameters"]["query"];
  if (read.endsWith("/payroll/reference/rates")) return { legal_entity_id: record } satisfies operations["listPayrollReferenceRates"]["parameters"]["query"];
  if (read.endsWith("/payroll/runs/preview")) return { pay_group_id: record, kind: "REGULAR" } satisfies operations["previewPayrollRun"]["parameters"]["query"];
  return {};
}

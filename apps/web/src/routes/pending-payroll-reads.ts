// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
// Pending pay-group/reference reads; served run reads use generated Cedar metadata.
export const pendingPayrollReads = {
  "GET /api/v1/payroll/pay-groups": { domain: "pay", level: "view" },
  "GET /api/v1/payroll/reference/rates": { domain: "pay", level: "view" },
} as const satisfies Record<string, Requirement>;

// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
// S1b allow-list until S1a publishes x-console-authz pay:view and the generator owns these reads.
export const pendingPayrollReads = {
  "GET /api/v1/payroll/pay-groups": { domain: "pay", level: "view" },
  "GET /api/v1/payroll/reference/rates": { domain: "pay", level: "view" },
  "GET /api/v1/payroll/runs": { domain: "pay", level: "view" },
} as const satisfies Record<string, Requirement>;

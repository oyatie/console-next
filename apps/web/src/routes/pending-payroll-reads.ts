// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
// Replace pending operation metadata with generated Cedar requirements when the contracts land.
export const pendingPayrollReads = {
  "GET /api/v1/payroll/reference/rates": { domain: "pay", level: "view" },
  "POST /api/v1/payroll/runs": { domain: "pay", level: "edit", tenant: true, scopes: ["TENANT"] },
} as const satisfies Record<string, Requirement>;

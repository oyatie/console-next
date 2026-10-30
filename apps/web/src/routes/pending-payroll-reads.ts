// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
// Only reference rates remain pending; pay groups and runs use generated Cedar metadata.
export const pendingPayrollReads = {
  "GET /api/v1/payroll/reference/rates": { domain: "pay", level: "view" },
} as const satisfies Record<string, Requirement>;

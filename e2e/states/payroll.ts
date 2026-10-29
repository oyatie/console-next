// SPDX-License-Identifier: LicenseRef-Proprietary
const states = { empty: "Setup with no PayGroup / no reference rows.", populated: "Groups and enum statuses / cited reference rows.", failed: "500 with retry.", refused: "403 shared refusal.", loading: "Hold the primary read.", held: "Uncited figure is withheld.", unsupported: "No adopted country pack; never KR fallback." } as const;
export const payrollScreens = [
  { key: "payroll", path: "/payroll", read: "/api/v1/payroll/pay-groups", states, registry: "payroll/2026-10-15-global/S1-home-global--ko", live: "S1a pending" },
  { key: "payroll-reference", path: "/payroll/reference", read: "/api/v1/payroll/reference/rates", states, registry: "payroll/2026-10-15-global/S5-rate-tables-global--ko", live: "S1a pending" },
] as const;
export type PayrollState = keyof typeof states;

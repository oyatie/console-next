// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "../schema";
// Payroll aliases backed by the generated contract.
export type PayGroup = components["schemas"]["PayGroup"];
export type PayGroups = components["schemas"]["PayGroupPage"];
export type PayrollRun = components["schemas"]["PayrollRunSummary"];
export type PayrollRunDetail = components["schemas"]["PayrollRunDetail"];
export type PayrollRate = components["schemas"]["PayrollRate"];
export type PayrollRates = components["schemas"]["PayrollRates"];
export type PayrollPaths = {
  "/api/v1/payroll/pay-groups": paths["/api/v1/payroll/pay-groups"];
  "/api/v1/payroll/reference/rates": paths["/api/v1/payroll/reference/rates"];
  "/api/v1/payroll/runs": paths["/api/v1/payroll/runs"];
  "/api/v1/payroll/runs/{id}": paths["/api/v1/payroll/runs/{id}"];
};

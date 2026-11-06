// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "../schema";
// Requested S1a contract. Replace this overlay when the generated payroll contract lands.
export type PayGroup = components["schemas"]["PayGroup"];
export type PayGroups = components["schemas"]["PayGroupPage"];
export type PayrollRun = components["schemas"]["PayrollRunSummary"];
export type PayrollRunDetail = components["schemas"]["PayrollRunDetail"];
export type PayrollRate = components["schemas"]["PayrollStatutoryCitation"] & { name: string; value: string; status: "ACTIVE" | "HELD" | "SCHEDULED" };
export type PayrollRates = { country_code: string; adopted: boolean; items: PayrollRate[] };
type Read<T, Q = Record<string, never>> = { parameters: { query?: Q }; responses: { 200: { content: { "application/json": T } } } };
export type PayrollPaths = {
  "/api/v1/payroll/pay-groups": paths["/api/v1/payroll/pay-groups"];
  "/api/v1/payroll/reference/rates": { get: Read<PayrollRates, { legal_entity_id: string }> };
  "/api/v1/payroll/runs": paths["/api/v1/payroll/runs"];
  "/api/v1/payroll/runs/{id}": paths["/api/v1/payroll/runs/{id}"];
};

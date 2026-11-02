// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "../schema";
// Requested S1a contract. Replace this overlay when the generated payroll contract lands.
export type PayrollModule = { key: "payroll"; ready: boolean; unblock: null };
export type PayGroup = components["schemas"]["PayGroup"];
export type PayGroups = components["schemas"]["PayGroupPage"];
export type PayrollRun = components["schemas"]["PayrollRunSummary"] & { legal_entity_id: string; pay_group_id: string };
export type CreatePayrollRun = { pay_group_id: string; source_label: string; period_start: string; period_end: string };
export type PayrollRunDetail = Omit<components["schemas"]["PayrollRunDetail"], "run"> & { run: PayrollRun };
export type PayrollRate = components["schemas"]["PayrollStatutoryCitation"] & { name: string; value: string; status: "ACTIVE" | "HELD" | "SCHEDULED" };
export type PayrollRates = { country_code: string; adopted: boolean; items: PayrollRate[] };
type Read<T, Q = Record<string, never>> = { parameters: { query?: Q }; responses: { 200: { content: { "application/json": T } } } };
type RunRead = paths["/api/v1/payroll/runs"]["get"];
type DetailRead = paths["/api/v1/payroll/runs/{id}"]["get"];
// Only run-to-group fields remain pending; keep generated pagination, parameters and refusals.
type RunPage = Omit<components["schemas"]["PayrollRunPage"], "items"> & { items: PayrollRun[] };
export type PayrollPaths = {
  "/api/v1/payroll/pay-groups": paths["/api/v1/payroll/pay-groups"];
  "/api/v1/payroll/reference/rates": { get: Read<PayrollRates, { legal_entity_id: string }> };
  "/api/v1/payroll/runs": { get: Omit<RunRead, "responses"> & { responses: Omit<RunRead["responses"], 200> & {
    200: Omit<RunRead["responses"][200], "content"> & { content: { "application/json": RunPage } };
  } }; post: {
    parameters: { header: { "idempotency-key": string } };
    requestBody: { content: { "application/json": CreatePayrollRun } };
    responses: { 201: { content: { "application/json": PayrollRun } } } & Pick<RunRead["responses"], 401 | 403>;
  } };
  "/api/v1/payroll/runs/{id}": { get: Omit<DetailRead, "responses"> & { responses: Omit<DetailRead["responses"], 200> & {
    200: { content: { "application/json": PayrollRunDetail } };
  } } };
};

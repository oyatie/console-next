// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";
import { api, unwrap, type components } from "@console/api";
import type { operations } from "@console/api/schema";
export { payGroupSchemas } from "@console/api";
export type { PayGroup, PayrollRate, PayrollRates, PayrollRun } from "@console/api/pending";
export type CreatePayGroup = components["schemas"]["CreatePayGroup"];
export type CreatePayrollRun = components["schemas"]["CreatePayrollRun"];
type PayrollRunQueryParams = operations["getPayrollRun"]["parameters"]["query"];
export const createPayGroup = (body: CreatePayGroup, key: string) => unwrap(api.POST("/api/v1/payroll/pay-groups", { body, headers: { "idempotency-key": key } }));
export const createPayrollRun = (body: CreatePayrollRun, key: string) => unwrap(api.POST("/api/v1/payroll/runs", { body, headers: { "idempotency-key": key } }));
export const payGroupsQuery = get("/api/v1/payroll/pay-groups");
type PayrollRunsQueryParams = operations["listPayrollRuns"]["parameters"]["query"];
const payrollRunsQuery = (params?: PayrollRunsQueryParams) =>
  get("/api/v1/payroll/runs", params ? { params: { query: params } } : undefined);
export const payrollRunsPages = (
  params?: Omit<NonNullable<PayrollRunsQueryParams>, "offset">,
  pageSize = 50,
) => ({
  ...payrollRunsQuery({ ...params, limit: params?.limit ?? pageSize }),
  queryFn: ({ pageParam }: { pageParam: number }) =>
    payrollRunsQuery({ ...params, limit: params?.limit ?? pageSize, offset: pageParam }).queryFn(),
  initialPageParam: 0,
  getNextPageParam: (page: components["schemas"]["PayrollRunPage"]) =>
    page.items.length > 0 && page.offset + page.items.length < page.total
      ? page.offset + page.items.length
      : undefined,
});
export const payrollRunPreviewQuery = (input: CreatePayrollRun) => get("/api/v1/payroll/runs/preview", { params: { query: input } });
function compactPayrollRunQuery(query?: PayrollRunQueryParams): PayrollRunQueryParams {
  if (!query) return undefined;
  const out: NonNullable<PayrollRunQueryParams> = {};
  if (typeof query.limit === "number" && query.limit > 0) out.limit = query.limit;
  if (typeof query.offset === "number" && query.offset > 0) out.offset = query.offset;
  if (query.missing_bank_only) out.missing_bank_only = true;
  const trimmed = query.q?.trim();
  if (trimmed) out.q = trimmed;
  return Object.keys(out).length > 0 ? out : undefined;
}
export const payrollRunQuery = (id: string, query?: PayrollRunQueryParams) => {
  const clean = compactPayrollRunQuery(query);
  return get("/api/v1/payroll/runs/{id}", { params: { path: { id }, ...(clean ? { query: clean } : {}) } });
};
export const payrollRatesQuery = (id: string) => get("/api/v1/payroll/reference/rates", { params: { query: { legal_entity_id: id } } });

export type ContractWage = operations["createEmployeeContractWage"]["requestBody"]["content"]["application/json"];
export const recordContractWage = ({ employeeId, body }: { employeeId: string; body: ContractWage }, key: string) => unwrap(api.POST("/api/v1/payroll/employees/{employeeId}/contract-wages", { params: { path: { employeeId } }, body, headers: { "idempotency-key": key } }));
export const payslipDraftQuery = (employeeId: string, period: string, pay_date: string) => get("/api/v1/payroll/employees/{employeeId}/payslip-draft", { params: { path: { employeeId }, query: { period, pay_date } } });

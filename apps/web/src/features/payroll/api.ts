// SPDX-License-Identifier: LicenseRef-Proprietary
import { get, read } from "../../lib/query";
import { api, unwrap, type components } from "@console/api";
import type { operations } from "@console/api/schema";
export { payGroupSchemas } from "@console/api/pay-group-schema";
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

// --- M5 Phase 5 Payroll Run Lifecycle (12 endpoints) ---
type _PayrollClosePreflight = components["schemas"]["PayrollClosePreflight"];
export type PayrollException = components["schemas"]["PayrollException"];
type _PayrollPayslipDeliverySummary = components["schemas"]["PayrollPayslipDeliverySummary"];

export const payrollClosePreflightQuery = (id: string) =>
  ({ ...get("/api/v1/payroll/runs/{id}/close-preflight", { params: { path: { id } } }), retry: false });

export const closePayrollAttendance = (id: string) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/close-attendance", { params: { path: { id } }, body: { attest: true } }));

export const calculatePayrollRun = (id: string) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/calculate", { params: { path: { id } } }));

export const payrollExceptionsQuery = (id: string, query?: { limit?: number; offset?: number }) =>
  ({ ...get("/api/v1/payroll/runs/{id}/exceptions", { params: { path: { id }, query } }), retry: false });

export const resolvePayrollException = (id: string, exceptionId: string, body: components["schemas"]["ResolvePayrollExceptionRequest"]) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/exceptions/{exceptionId}/resolve", { params: { path: { id, exceptionId } }, body }));

export const submitPayrollRun = (id: string) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/submit", { params: { path: { id } } }));

export const decidePayrollRun = (id: string, body: components["schemas"]["DecidePayrollRunRequest"]) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/decision", { params: { path: { id } }, body }));

export const withdrawPayrollRun = (id: string) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/withdraw", { params: { path: { id } } }));

export const schedulePayrollDisbursement = (id: string, scheduled_at: string) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/schedule-disbursement", { params: { path: { id } }, body: { scheduled_at } }));

export const attestPayrollDisbursement = (id: string, body: components["schemas"]["AttestPayrollDisbursementRequest"]) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/disbursement/attest", { params: { path: { id } }, body }));

export const issuePayrollPayslips = (id: string) =>
  unwrap(api.POST("/api/v1/payroll/runs/{id}/issue-payslips", { params: { path: { id } } }));

export const payrollPayslipDeliveryQuery = (id: string, query?: { limit?: number; offset?: number }) =>
  ({ ...get("/api/v1/payroll/runs/{id}/payslip-delivery", { params: { path: { id }, query } }), retry: false });

type Membership = operations["assignPayGroupMember"]["requestBody"]["content"]["application/json"];
export const payGroupCandidates = (query: operations["searchPayGroupMembers"]["parameters"]["query"]) =>
  get("/api/v1/payroll/pay-group-memberships", { params: { query } });
export const assignMembership = (body: Membership, key: string) =>
  unwrap(api.POST("/api/v1/payroll/pay-group-memberships", { body, headers: { "idempotency-key": key } }));

export type PayrollScenario = { series: number[]; horizon: number };
export type Projection = components["schemas"]["ProjectionResult"];

const projectPayroll = (request: PayrollScenario) => unwrap(api.POST("/api/v1/analytics/projection", { body: { ...request, kind: "money" } }));

/** An opaque per-submit key keeps entered payroll amounts out of query keys and separates overlapping scenarios. */
export const payrollProjectionQuery = (submitted: { key: string; request: PayrollScenario } | null) => ({
  ...read("/api/v1/analytics/projection", async () => {
    if (!submitted) throw new Error("No payroll scenario submitted");
    return projectPayroll(submitted.request);
  }, submitted?.key),
  enabled: submitted !== null, retry: false, gcTime: 0, staleTime: Infinity,
});

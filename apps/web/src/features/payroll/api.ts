// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";
import { api, unwrap, type components } from "@console/api";
export { payGroupSchemas } from "@console/api";
export type { PayGroup, PayrollRate, PayrollRates, PayrollRun } from "@console/api/pending";
export type CreatePayGroup = components["schemas"]["CreatePayGroup"];
export const createPayGroup = (body: CreatePayGroup, key: string) => unwrap(api.POST("/api/v1/payroll/pay-groups", { body, headers: { "idempotency-key": key } }));
export const payGroupsQuery = get("/api/v1/payroll/pay-groups");
export const payrollRunsQuery = get("/api/v1/payroll/runs");
export const payrollRunQuery = (id: string) => get("/api/v1/payroll/runs/{id}", { params: { path: { id } } });
export const payrollRatesQuery = (id: string) => get("/api/v1/payroll/reference/rates", { params: { query: { legal_entity_id: id } } });

export type ContractWage = import("@console/api/schema").operations["createEmployeeContractWage"]["requestBody"]["content"]["application/json"];
export const recordContractWage = ({ employeeId, body }: { employeeId: string; body: ContractWage }, key: string) => unwrap(api.POST("/api/v1/payroll/employees/{employeeId}/contract-wages", { params: { path: { employeeId } }, body, headers: { "idempotency-key": key } }));
export const payslipDraftQuery = (employeeId: string, period: string, pay_date: string) => get("/api/v1/payroll/employees/{employeeId}/payslip-draft", { params: { path: { employeeId }, query: { period, pay_date } } });

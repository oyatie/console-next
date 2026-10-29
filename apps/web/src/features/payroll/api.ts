// SPDX-License-Identifier: LicenseRef-Proprietary
import { get } from "../../lib/query";
export type { PayGroup, PayrollRate, PayrollRates, PayrollRun } from "@console/api/pending";
export const payGroupsQuery = get("/api/v1/payroll/pay-groups");
export const payrollRunsQuery = get("/api/v1/payroll/runs");
export const payrollRatesQuery = (id: string) => get("/api/v1/payroll/reference/rates", { params: { query: { legal_entity_id: id } } });

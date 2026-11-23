// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../../lib/query";

type Employee = components["schemas"]["Employee"];
type EmployeePage = components["schemas"]["EmployeePage"];

const CONSOLE_FULL_PAGE = 1000;
const MAX_FULL_PAGES = 20;

/** Walks keyset/cursor pages of `GET /api/v1/employees` for client-side Console filters across the full roster. */
export async function fetchAllConsoleRows(query: object): Promise<Employee[]> {
  const items: Employee[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < MAX_FULL_PAGES; pageIndex += 1) {
    const page = (await unwrap(
      api.GET("/api/v1/employees", {
        params: { query: { ...query, limit: CONSOLE_FULL_PAGE, cursor } },
      } as never),
    )) as EmployeePage;
    for (const row of page.items) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        items.push(row);
      }
    }
    const next = page.next_cursor ?? undefined;
    if (!next || page.items.length === 0 || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return items;
}

/** Capability-gated attendance month summary peek for the Console roster side pane. */
export const personMonthPeekQuery = (employee_id: string, month: string) =>
  get("/api/v1/attendance/people/{employee_id}/month", { params: { path: { employee_id }, query: { month } } });

/** Capability-gated payslip draft summary peek (including social insurances) for the Console roster side pane. */
export const payslipDraftPeekQuery = (employeeId: string, period: string, pay_date: string) =>
  get("/api/v1/payroll/employees/{employeeId}/payslip-draft", { params: { path: { employeeId }, query: { period, pay_date } } });

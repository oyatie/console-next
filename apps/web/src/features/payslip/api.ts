// SPDX-License-Identifier: LicenseRef-Proprietary
export { ApiError } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../lib/query";

export type InboxDocSummary = components["schemas"]["InboxDocSummary"];

/** Issued employee payslips from the personal inbox document vault (read-only). */
export const myPayslipsListQuery = get("/api/v1/me/inbox-docs", {
  params: { query: { filter: "pay", limit: 200 } },
});

/** Single issued payslip detail with itemized breakdown payload. */
export const myPayslipDetailQuery = (id: string) =>
  get("/api/v1/me/inbox-docs/{id}", { params: { path: { id } } });

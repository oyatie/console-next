// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError } from "@console/api";
import { cursorPages, get } from "../../lib/query";
import { myAccessQuery } from "../../reference/authz/api";

export const teamAccessQuery = myAccessQuery;
export const teamMeQuery = get("/api/v1/users/me");

export const teamEmployeesPages = (params: {
  org_unit_id?: string;
  workplace_id?: string;
  legal_entity_id?: string;
  status?: "ACTIVE" | "ON_LEAVE";
  team_review_required?: boolean;
  contract_ending_before?: string;
  contract_ending_on_or_after?: string;
  search?: string;
  sort?: string;
  limit?: number;
}) => cursorPages("/api/v1/employees", params);

export const teamFacetsQuery = (params: {
  org_unit_id?: string;
  workplace_id?: string;
  legal_entity_id?: string;
  team_review_required?: boolean;
  contract_ending_before?: string;
  contract_ending_on_or_after?: string;
  search?: string;
  status?: "ACTIVE" | "ON_LEAVE";
}) => get("/api/v1/employees/facets", { params: { query: { ...params, status: params.status ? [params.status] : undefined } } });

export const teamLeaveQueueQuery = get("/api/v2/leave/requests", {
  params: { query: { status: "pending", limit: 20 } },
});

export function isRefusalError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components } from "@console/api";
import { get } from "../../../lib/query";

export type LeaveRosterEntry = components["schemas"]["LeaveRosterEntry"];
type LeavePromotionRequest = components["schemas"]["LeavePromotionRequest"];
type LeaveRefusalRequest = components["schemas"]["LeaveRefusalRequest"];

export const leaveBalancesQuery = get("/api/v1/leave/balances");
export const branchesQuery = get("/api/v1/branches");
export const directoryPeopleQuery = get("/api/v1/directory/people", {
  params: { query: { limit: 200, include_inactive: false } },
});

export const pushLeavePromotion = (body: LeavePromotionRequest) =>
  unwrap(api.POST("/api/v1/leave/promotions", { body }));

export const pushLeaveRefusalNotice = (body: LeaveRefusalRequest) =>
  unwrap(api.POST("/api/v1/leave/refusal-notices", { body }));

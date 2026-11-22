// SPDX-License-Identifier: LicenseRef-Proprietary
import { ApiError, api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../lib/query";
import { isoMondayOf } from "./domain/week";

type S = components["schemas"];

export type OwnScheduleCalendar = S["AttendanceScheduleCalendar"];
export type OwnException = S["OwnAttendanceException"];
export type OwnWeek52 = S["OwnAttendanceWeek52Response"];
export type OwnAttendanceRecord = S["EmployeeAttendanceRecord"];
export type AttendanceRecordKind = S["AttendanceRecordKind"];

export const meUserQuery = get("/api/v1/users/me");
export const myProfileQuery = get("/api/v1/me/profile");
export const myLeaveOverviewQuery = get("/api/v2/me/leave", { params: { query: { limit: 5 } } });
export const myPayslipsQuery = get("/api/v1/me/inbox-docs", { params: { query: { filter: "pay", limit: 5 } } });
export const myChangeRequestsQuery = get("/api/v1/change-requests", { params: { query: { requester: "me", status: "OPEN", limit: 5 } } });

export const myAttendanceScheduleQuery = (month: string) =>
  get("/api/v1/attendance/me/schedule", { params: { query: { month } } });

export const myAttendanceExceptionsQuery = (month: string) =>
  get("/api/v1/attendance/me/exceptions", { params: { query: { month, limit: 50 } } });

export const myAttendanceWeek52Query = (date: string) =>
  get("/api/v1/attendance/me/week52", { params: { query: { week_start: isoMondayOf(date) } } });

export const myAttendanceRecordsQuery = () =>
  get("/api/v1/hr/attendance-records/me", { params: { query: { limit: 50 } } });

export function createMyAttendanceRecord(body: S["CreateEmployeeAttendanceRecordRequest"]) {
  return unwrap(api.POST("/api/v1/hr/attendance-records/me", { body }));
}

export function isForbiddenError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

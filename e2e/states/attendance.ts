// SPDX-License-Identifier: LicenseRef-Proprietary
import { id } from "../mock/fixtures";

const states = {
  populated: "Return server-owned exception rows, close counts or week52 ledger totals and tones.",
  empty: "Return a successful empty board.",
  failed: "Return a referenced 500 on the primary read.",
  refused: "Return a referenced 403 on the primary read; supporting reads succeed.",
  loading: "Hold the primary read until released.",
} as const;
export const attendanceScreens = [
  { key: "attendance-issues", tab: "issues", path: `/attendance?tab=issues&month=2026-10&date=2026-10-04&wp=${id(4)}`, read: "/api/v1/attendance/exceptions", states, registry: "attendance--issues", live: "e2e/attendance-records.spec.ts" },
  { key: "attendance-close", tab: "close", path: `/attendance?tab=close&month=2026-10&date=2026-10-04&wp=${id(4)}`, read: "/api/v1/attendance/closes", states, registry: "attendance--close", live: "e2e/attendance-closed-month.spec.ts" },
  { key: "attendance-overtime", tab: "overtime", path: `/attendance?tab=overtime&month=2026-10&date=2026-10-04&wp=${id(4)}`, read: "/api/v1/attendance/week52", states, registry: "attendance--overtime", live: "e2e/attendance-weekly-limits.spec.ts" },
] as const;
export type AttendanceState = keyof typeof states;

export const attendanceBoardScreens = [
  { key: "attendance-month", path: "/attendance?tab=month&month=2026-10", read: "/api/v1/attendance/month", states, registry: "attendance--month", live: "e2e/attendance-records.spec.ts" },
  { key: "attendance-day", path: "/attendance?tab=day&date=2026-10-04", read: "/api/v1/attendance/days", states, registry: "attendance--day", live: "e2e/attendance-records.spec.ts" },
  { key: "attendance-person", path: `/attendance?tab=month&month=2026-10&person=${id(100)}`, read: "/api/v1/attendance/people/{employee_id}/month", states, registry: "attendance--person", live: "e2e/attendance-records.spec.ts" },
  { key: "attendance-calendar", path: "/attendance?tab=schedule&month=2026-10", read: "/api/v1/attendance/schedule/calendar", states, registry: "attendance--schedule", live: "e2e/attendance-schedule.spec.ts" },
] as const;

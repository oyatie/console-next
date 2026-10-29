// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Page } from "@playwright/test";
import type { components } from "@console/api";
import type { Week52Row } from "../../apps/web/src/features/attendance/api";
import type { AttendanceState, attendanceScreens } from "../states/attendance";
import { AT, failure, id } from "./fixtures";
import { mockRoute } from "./route";

type S = components["schemas"];
export const attendanceReference = "0123456789abcdef0123456789abcdef";
const exceptions: S["AttendanceException"][] = ["LATE", "UNAPPROVED_OVERTIME", "EARLY_LEAVE"].map((kind, i) => ({
  id: id(600 + i), code: `AT-${i}`, kind: kind as S["AttendanceException"]["kind"], status: "OPEN", employee_id: id(100 + i),
  employee_name: `검증직원 ${i + 1}`, branch_id: id(4), work_date: `2026-10-0${i + 1}`, occurred_at: AT, detail: "근태 확인", evidence: [], links: [], created_at: AT,
}));
const closeItems: S["AttendanceMonthCloseItem"][] = [
  { branch_scope: id(4), closed: false, open_exceptions: 7, pending_leave: 2 },
  { branch_scope: id(5), closed: true, open_exceptions: 0, pending_leave: 0 },
];
const weekRows: Week52Row[] = (["OK", "WARN", "DANGER", "UNKNOWN"] as const).map((tone, i) => ({
  employee_id: id(100 + i), name: `검증직원 ${i + 1}`, week_start: "2026-09-28", current_hours: 20 + i, projected_hours: 30 + i, tone, acked: false,
  ...(tone === "UNKNOWN" ? {} : { recognized_hours: 32.5 + i, overtime_hours: 1.5 + i }),
}));

/** Attendance reads only; the common shell remains owned by mockScreen. */
export async function attendanceReads(page: Page, screen: typeof attendanceScreens[number], state: AttendanceState) {
  const requests: { path: string; query: Record<string, string> }[] = [];
  const forbidden: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/leave/") || url.pathname === "/api/v1/hr/leave-balances") forbidden.push(url.pathname);
  });
  await mockRoute(page, "get", "/api/v1/attendance/schedule/tree", { status: 200, json: {
    date: "2026-10-04", people_total: 4, people_unscheduled: 0, holidays_loaded: true,
    nodes: [{ id: id(4), kind: "WORKPLACE", name: "본사", people: 4, unscheduled: 0 }],
  } });
  await mockRoute(page, "get", "/api/v1/branches", { status: 200, json: [
    { id: id(4), name: "본사", region_id: id(3), created_at: AT, deactivated_at: null }, { id: id(5), name: "부산사업장", region_id: id(3), created_at: AT, deactivated_at: null },
  ] });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const paths = ["/api/v1/attendance/exceptions", "/api/v1/attendance/closes", "/api/v1/attendance/week52"] as const;
  for (const path of paths) {
    // 500 is intentionally outside this operation's documented response union.
    await page.route(url => url.pathname === path, async route => {
      const url = new URL(route.request().url());
      requests.push({ path, query: Object.fromEntries(url.searchParams) });
      if (path === screen.read && state === "loading") await held;
      const failed = path === screen.read && (state === "failed" || state === "refused");
      if (failed) return route.fulfill({ status: state === "failed" ? 500 : 403, json: { error: { ...failure(state === "failed" ? "internal" : "forbidden").error, support_ref: attendanceReference, support_ref_at: AT } } });
      const empty = state === "empty";
      const offset = Number(url.searchParams.get("offset") ?? 0), limit = 2;
      const json = path === paths[0] ? { items: empty ? [] : exceptions.slice(offset, offset + limit), total: empty ? 0 : exceptions.length, offset, limit } satisfies S["AttendanceExceptionPage"]
        : path === paths[1] ? { month: url.searchParams.get("month")!, items: empty ? [] : closeItems } satisfies S["AttendanceCloseBoard"]
        : { week_start: url.searchParams.get("week_start")!, items: empty ? [] : weekRows } satisfies S["AttendanceWeek52Board"];
      if (!page.isClosed()) await route.fulfill({ status: 200, json });
    });
  }
  return { requests, forbidden, release };
}

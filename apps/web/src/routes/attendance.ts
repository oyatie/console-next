import { readRequirement } from "./route-reads";
import { createElement } from "react";
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { AttendanceSearch } from "../features/attendance/ui/attendance-page";
import { app, screen, str } from "./app";

const VIEWS = ["calendar", "types", "crews", "holidays", "public"] as const;
const KINDS = ["LEGAL_ENTITY", "WORKPLACE", "DEPARTMENT", "CREW", "PERSON"] as const;
const TABS = ["month", "day", "week", "schedule"] as const;
const load = () => import("../features/attendance/ui/attendance-page");
const Schedule = lazyRouteComponent(screen(load), "AttendancePage");
const Month = lazyRouteComponent(screen(load), "MonthPage");
const Day = lazyRouteComponent(screen(load), "DayPage");
const Week = lazyRouteComponent(screen(load), "WeeklyPage");
const Person = lazyRouteComponent(screen(load), "PersonPage");
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// attendance (decision #22): the tab (month grid by default, day board, work schedule), scope, month or day and an open person card live in
// the URL so a link reopens the same view.
const attendance = createRoute({
  getParentRoute: () => app,
  path: "/attendance", staticData: { access: readRequirement("/attendance") },
  validateSearch: (s: Record<string, unknown>): AttendanceSearch => ({
    view: VIEWS.find((v) => v === s.view),
    kind: KINDS.find((k) => k === s.kind),
    id: str(s.id),
    month: typeof s.month === "string" && /^\d{4}-\d{2}$/.test(s.month) ? s.month : undefined,
    tab: TABS.find((x) => x === s.tab),
    date: typeof s.date === "string" && ISO.test(s.date) ? s.date : undefined,
    wp: str(s.wp),
    unit: str(s.unit),
    person: str(s.person),
    detail: s.detail === true || s.detail === "1" ? true : undefined,
    issues: s.issues === true || s.issues === "1" ? true : undefined,
    unscheduled: s.unscheduled === true || s.unscheduled === "1" ? true : undefined,
  }),
  component: () => {
    const search = attendance.useSearch();
    return createElement(search.person ? Person : search.tab === "schedule" ? Schedule : search.tab === "day" ? Day : search.tab === "week" ? Week : Month);
  },
});

export const attendanceRoutes = [attendance];

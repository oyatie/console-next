// SPDX-License-Identifier: LicenseRef-Proprietary
import { DISPATCH_OFFERS_MODULE } from "../reference/onboarding/api";
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { MeAttendanceSearch } from "../features/me/ui/me-attendance-page";
import type { MeDeskSearch, MeDeskView } from "../features/me/ui/me-desk-page";
import { app, screen, str } from "./app";
import { servedRouteAccess } from "./route-reads";

const DESK_VIEWS: readonly MeDeskView[] = ["overview", "attendance", "requests", "documents"];

const meAttendance = createRoute({
  getParentRoute: () => app,
  path: "/me/attendance",
  staticData: { access: "signed-in", floorplan: "P-02", pattern: "record" },
  validateSearch: (s: Record<string, unknown>): MeAttendanceSearch => ({
    month: typeof s.month === "string" && /^\d{4}-\d{2}$/.test(s.month) ? s.month : undefined,
    week: typeof s.week === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.week) ? s.week : undefined,
  }),
  component: lazyRouteComponent(screen(() => import("../features/me/ui/me-attendance-page")), "MeAttendancePage"),
});

const loadMeDesk = () => import("../features/me/ui/me-desk-page");
const meDesk = createRoute({
  getParentRoute: () => app,
  path: "/me/desk",
  staticData: { access: "signed-in", floorplan: "P-05", pattern: "settings" },
  validateSearch: (s: Record<string, unknown>): MeDeskSearch => ({
    view: DESK_VIEWS.find(v => v === s.view),
  }),
  component: lazyRouteComponent(screen(loadMeDesk), "MeDeskPage"),
});

const meDispatchOffers = createRoute({
  getParentRoute: () => app,
  path: "/me/dispatch-offers",
  staticData: { access: "signed-in", module: DISPATCH_OFFERS_MODULE, floorplan: "P-03", pattern: "worklist" },
  validateSearch: (s: Record<string, unknown>): { sel?: string } => ({ sel: str(s.sel) }),
  component: lazyRouteComponent(screen(loadMeDesk), "MeDispatchOffers"),
});

const meEvaluations = createRoute({
  getParentRoute: () => app,
  path: "/me/evaluations",
  staticData: { access: servedRouteAccess["/me/evaluations"], floorplan: "P-01", pattern: "list-record" },
  component: lazyRouteComponent(screen(() => import("../features/me/ui/evaluation-tasks")), "EvaluationTasks"),
});

const calendar = createRoute({
  getParentRoute: () => app, path: "/calendar",
  staticData: { access: servedRouteAccess["/calendar"], floorplan: "P-03", pattern: "month-grid" },
  component: lazyRouteComponent(screen(() => import("../features/calendar/ui/calendar-page")), "CalendarPage"),
});
export const meRoutes = [meAttendance, meDesk, meDispatchOffers, meEvaluations, calendar];

// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import type { MeAttendanceSearch } from "../features/me/ui/me-attendance-page";
import type { MeDeskSearch, MeDeskView } from "../features/me/ui/me-desk-page";
import { app, screen } from "./app";

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
  staticData: { access: "signed-in", floorplan: "P-03", pattern: "worklist" },
  component: lazyRouteComponent(screen(loadMeDesk), "MeDispatchOffers"),
});

export const meRoutes = [meAttendance, meDesk, meDispatchOffers];

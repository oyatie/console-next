import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, flag, screen, str } from "./app";
import { STRUCTURE_ACTS } from "../reference/org/domain/structure";

/** The proposal or structure sheet a panel opens for its selection (`sel`). Regions and branches are retired (decisions #18, MR-20). */
const ORG_ACTS = ["create", "rename", "move", "dissolve", "reassign", ...STRUCTURE_ACTS] as const;
type OrgAct = (typeof ORG_ACTS)[number];
const KINDS = ["DEPARTMENT"] as const;
const STRUCTURE_VIEWS = ["list", "outline"] as const;
const VIEWS = ["open", "mine", "approval", "ready", "done", "closed", "all"] as const;
const DONE = ["submitted", "drafted", "redrafted"] as const;
const oneOf = <T extends string>(all: readonly T[], v: unknown): T | undefined => (all.includes(v as T) ? (v as T) : undefined);

const org = createRoute({
  getParentRoute: () => app,
  path: "/org",
  // The company structure: `view` (the chart by default, the list or the outline), `focus` (the box the chart is
  // centred on), `sel` (the selection whose panel shows) and the proposal or structure sheet `act` for it.
  validateSearch: (s: Record<string, unknown>): { view?: (typeof STRUCTURE_VIEWS)[number]; focus?: string; sel?: string; act?: OrgAct; kind?: (typeof KINDS)[number]; as_of?: string; known_at?: string; compare_a?: string; compare_b?: string } => ({
    view: oneOf(STRUCTURE_VIEWS, s.view),
    focus: str(s.focus),
    sel: str(s.sel),
    act: oneOf(ORG_ACTS, s.act),
    kind: oneOf(KINDS, s.kind),
    as_of: str(s.as_of),
    known_at: str(s.known_at),
    compare_a: str(s.compare_a),
    compare_b: str(s.compare_b),
  }),
  component: lazyRouteComponent(screen(() => import("./org-screen")), "OrgScreen"),
});
const orgChanges = createRoute({
  getParentRoute: () => app,
  path: "/org/changes",
  validateSearch: (s: Record<string, unknown>): { view?: (typeof VIEWS)[number]; effective_from?: string; effective_to?: string } => ({
    view: oneOf(VIEWS, s.view),
    effective_from: str(s.effective_from),
    effective_to: str(s.effective_to),
  }),
  component: lazyRouteComponent(screen(() => import("../features/org/OrgChange")), "OrgChanges"),
});
const orgChange = createRoute({
  getParentRoute: () => app,
  path: "/org/changes/$id",
  validateSearch: (s: Record<string, unknown>): { unsent?: boolean; done?: (typeof DONE)[number] } => ({ unsent: flag(s.unsent), done: oneOf(DONE, s.done) }),
  component: lazyRouteComponent(screen(() => import("../features/org/OrgChange")), "OrgChange"),
});

/** S8: moving the department `ids` (comma-separated, as chosen on the chart) to one place, as one batch or one proposal. */
const orgMove = createRoute({
  getParentRoute: () => app,
  path: "/org/move",
  validateSearch: (s: Record<string, unknown>): { ids?: string } => ({ ids: str(s.ids) }),
  component: lazyRouteComponent(screen(() => import("../features/org/ui/bulk-move-page")), "BulkMovePage"),
});

export const orgRoutes = [org, orgChanges, orgChange, orgMove];

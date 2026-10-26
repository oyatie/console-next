import { readRequirement } from "./route-reads";
// The bulk paths and history of company structure (S7, S9): full pages beside /org.
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen, str } from "./app";

const paste = createRoute({
  getParentRoute: () => app,
  path: "/org/paste", staticData: { access: readRequirement("/org/paste") },
  // Paste under a legal entity (first level workplace) or a workplace (every level department); neither asks where.
  validateSearch: (s: Record<string, unknown>): { entity?: string; workplace?: string } => ({ entity: str(s.entity), workplace: str(s.workplace) }),
  component: lazyRouteComponent(screen(() => import("../features/org-bulk/ui/paste-page")), "PastePage"),
});

const sheetImport = createRoute({
  getParentRoute: () => app,
  path: "/org/import", staticData: { access: readRequirement("/org/import") },
  component: lazyRouteComponent(screen(() => import("../features/org-bulk/ui/import-page")), "ImportPage"),
});
const bulkEdit = createRoute({
  getParentRoute: () => app,
  path: "/org/workplaces/edit", staticData: { access: readRequirement("/org/workplaces/edit") },
  component: lazyRouteComponent(screen(() => import("../features/org-bulk/ui/bulk-edit-page")), "BulkEditPage"),
});
const history = createRoute({
  getParentRoute: () => app,
  path: "/org/history", staticData: { access: readRequirement("/org/history") },
  component: lazyRouteComponent(screen(() => import("../features/org-bulk/ui/history-page")), "HistoryPage"),
});

export const orgBulkRoutes = [paste, sheetImport, bulkEdit, history];

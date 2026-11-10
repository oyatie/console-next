// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { approvalBox, type ApprovalBox } from "../features/approvals/domain/inbox";
import { APPROVALS_MODULE } from "../reference/onboarding/api";
import { app, screen, str } from "./app";

type ApprovalsSearch = { box?: Exclude<ApprovalBox, "pending">; q?: string; source?: string; sel?: string; full?: 1 };
export const approvalsRoute = createRoute({
  getParentRoute: () => app,
  path: "/approvals",
  staticData: { access: "signed-in", module: APPROVALS_MODULE, floorplan: "P-03" },
  validateSearch: (search: Record<string, unknown>): ApprovalsSearch => {
    const box = approvalBox(search.box);
    // Links saved before the document column carried the selection as `focus`.
    const sel = str(search.sel) ?? str(search.focus);
    return { box: box === "pending" ? undefined : box, q: str(search.q), source: str(search.source), sel, full: sel && (search.full === 1 || search.full === "1") ? 1 : undefined };
  },
  component: lazyRouteComponent(screen(() => import("../features/approvals/ui/approvals-page")), "ApprovalsPage"),
});

export const approvalViewerRoute = createRoute({
  getParentRoute: () => app,
  path: "/approvals/$approvalId",
  staticData: { access: "signed-in", module: APPROVALS_MODULE, floorplan: "P-02" },
  remountDeps: ({ params }) => params.approvalId,
  component: lazyRouteComponent(screen(() => import("../features/approvals/ui/approval-viewer")), "ApprovalViewerPage"),
});

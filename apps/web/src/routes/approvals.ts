// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { approvalBox, type ApprovalBox } from "../features/approvals/domain/inbox";
import { APPROVALS_MODULE } from "../reference/onboarding/api";
import { app, screen, str } from "./app";

type ApprovalsSearch = { box?: Exclude<ApprovalBox, "pending">; q?: string; source?: string; focus?: string };
export const approvalsRoute = createRoute({
  getParentRoute: () => app,
  path: "/approvals",
  staticData: { access: "signed-in", module: APPROVALS_MODULE, floorplan: "P-03" },
  validateSearch: (search: Record<string, unknown>): ApprovalsSearch => {
    const box = approvalBox(search.box);
    return { box: box === "pending" ? undefined : box, q: str(search.q), source: str(search.source), focus: str(search.focus) };
  },
  component: lazyRouteComponent(screen(() => import("../features/approvals/ui/approvals-page")), "ApprovalsPage"),
});

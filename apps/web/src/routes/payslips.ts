// SPDX-License-Identifier: LicenseRef-Proprietary
import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { app, screen, str } from "./app";

const DOC_RE = /^[0-9a-f-]{1,64}$/i;
const MONTH_RE = /^\d{4}-(?:0[1-9]|1[0-2])$/;

const safeDoc = (value: unknown) => {
  const s = str(value);
  return s && DOC_RE.test(s) ? s : undefined;
};

const safeMonth = (value: unknown) => {
  const s = str(value);
  return s && MONTH_RE.test(s) ? s : undefined;
};

export const payslipsRoute = createRoute({
  getParentRoute: () => app,
  path: "/payslips",
  staticData: { access: "signed-in", floorplan: "P-02", pattern: "phone-statement" },
  validateSearch: (s: Record<string, unknown>): { doc?: string; month?: string } => ({
    doc: safeDoc(s.doc),
    month: safeMonth(s.month),
  }),
  component: lazyRouteComponent(screen(() => import("../features/payslip/ui/payslip-page")), "PayslipPage"),
});

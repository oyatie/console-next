// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
// oxlint-disable-next-line no-restricted-imports -- A refused draft read is a transport refusal.
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { queryPath } from "../../../lib/query";
import { EmployeePayConsole } from "./employee-pay-console";

const state = vi.hoisted(() => ({ refused: false }));
const draft = {
  employee_id: "e1", employee_name: "Pay One", period: { start: "2026-10-01", end: "2026-10-31" }, pay_date: "2026-11-05",
  contract: null, issuable: false, blockers: ["WITHHOLDING_NOT_COMPUTED"], statutory_citations: [], deductions: [],
  earnings: null, gross_won: null, minimum_wage_check: null, net_pay_won: null, not_computed: [],
};
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useParams: () => ({ employeeId: "e1" }), useSearch: () => ({ period: "2026-10", pay_date: "2026-11-05" }), useNavigate: () => vi.fn() }),
  Link: ({ children, to, search }: { children: ReactNode; to: string; search?: Record<string, string> }) => (
    <span data-href={`${to}${search ? `?${new URLSearchParams(search)}` : ""}`}>{children}</span>
  ),
}));
vi.mock("../../../ui/patterns/pattern-shell", async original => ({
  ...await original<typeof import("../../../ui/patterns/pattern-shell")>(),
  ExperienceSwitch: ({ children }: { children: () => ReactNode }) => <>{children()}</>,
}));
vi.mock("../../../experience/dom", () => ({ useActiveExperienceId: () => "console" }));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (q: Parameters<typeof queryPath>[0]) => queryPath(q).includes("payslip-draft")
    ? state.refused
      ? { isPending: false, error: new ApiError(403, "forbidden", "", [], "pay-ref"), data: undefined, refetch: vi.fn() }
      : { isPending: false, error: null, data: draft, refetch: vi.fn() }
    : { isPending: true, error: null, data: undefined, refetch: vi.fn() },
}));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.refused = false; });
const render = () => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><EmployeePayConsole baseline={() => null} /></QueryClientProvider>);

test("the draft's net pay says why it is blank, as Classic does, while the blockers carry the draft's state", () => {
  const html = render();
  expect(html).toContain(t("payroll.employee.netUnavailable"));
  expect(html).toContain(t("payroll.employee.incomplete"));
});

test("a refused draft returns to the person's card, not only home", () => {
  state.refused = true;
  const html = render();
  expect(html).toContain(t("common.denied.title.plain"));
  expect(html).toContain(`<span data-href="/people?sel=e1">${t("payroll.employee.person")}</span>`);
});

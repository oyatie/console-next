// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { ExitCases } from "./exit-block";

type Case = components["schemas"]["EmployeeExitCase"];
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }), Link: () => null }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => true }));
vi.mock("../api", () => ({
  exitCasesQuery: () => ({ queryKey: ["cases"], queryFn: () => new Promise(() => {}) }),
  caseQuery: (id: string) => ({ queryKey: ["case", id], queryFn: () => new Promise(() => {}) }),
}));
vi.mock("../present", () => ({ whoLine: () => "Synthetic employee" }));
vi.mock("./use-case-actions", () => ({
  useOwnRecord: () => false,
  useCaseActions: () => ({ next: "confirm_exit", forward: "confirm_exit", back: [], sameActor: false }),
}));
vi.mock("./exit-axis", () => ({ StepForm: ({ c }: { c: Case }) => <div role="dialog">{c.id}{c.protected_periods?.map((p) => <span key={p.lifecycle_event_id}>{p.article}</span>)}</div> }));
vi.mock("./exit-close", () => ({ CloseForm: () => null }));
vi.mock("./exit-report", () => ({ ReportForm: () => null }));
vi.mock("./exit-facts", () => ({ RelDay: () => null }));

beforeAll(() => loadCatalog("ko"));

function sheet(detail?: Case) {
  const client = new QueryClient();
  const c = { id: "case-1", status: "REPORTED", effective_exit_date: "2026-10-21", protected_periods: [] } as unknown as Case;
  client.setQueryData(["cases"], { items: [c] });
  if (detail) client.setQueryData(["case", c.id], detail);
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><ExitCases employee={{ id: "person-1", name: "Synthetic employee", status: "ACTIVE" } as components["schemas"]["Employee"]} act="exit.confirm_exit:case-1" /></QueryClientProvider>);
  client.clear();
  return html;
}

test("the HR sheet opens from its list row while the detail read is pending", () => {
  expect(sheet()).toContain('role="dialog">case-1');
});

test("the HR sheet refines the list row with the authorized protected periods", () => {
  const detail = { id: "case-1", protected_periods: [{ lifecycle_event_id: "leave-1", article: "제23조제2항" }] } as unknown as Case;
  expect(sheet(detail)).toContain("제23조제2항");
});

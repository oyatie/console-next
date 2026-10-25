// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import type { ReactNode } from "react";
import { ExitCases } from "./exit-block";
import { Button } from "../../../ui/button/button";
import s from "./exit.module.css";

type Case = components["schemas"]["EmployeeExitCase"];
const reads = vi.hoisted(() => ({ cases: [] as unknown[], detail: undefined as unknown, error: null as Error | null }));
// The list read has landed; the detail read is pending (placeholder) unless a detail is given.
vi.mock("@tanstack/react-query", () => ({
  useQuery: (q: { read: string; placeholderData?: unknown }) => q.read === "cases"
    ? { data: { items: reads.cases }, isSuccess: true }
    : { data: reads.error ? undefined : reads.detail ?? q.placeholderData, isSuccess: !reads.error && (reads.detail !== undefined || q.placeholderData !== undefined), isPlaceholderData: !reads.error && reads.detail === undefined, isError: !!reads.error, error: reads.error, refetch: vi.fn() },
}));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }), Link: () => null }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => true }));
vi.mock("../api", () => ({
  exitCasesQuery: () => ({ read: "cases" }),
  caseQuery: () => ({ read: "case" }),
}));
vi.mock("../present", () => ({ whoLine: () => "Synthetic employee" }));
vi.mock("./use-case-actions", () => ({
  useOwnRecord: () => false,
  useCaseActions: () => ({ next: "confirm_exit", forward: "confirm_exit", back: [], sameActor: false }),
}));
vi.mock("./exit-axis", () => ({ StepForm: ({ c, sheet: spec, aside }: { c: Case; sheet: { loading?: boolean }; aside?: ReactNode }) => <div role="dialog">{c.id}<Button disabled={spec.loading}>{t("exit.action.confirm_exit")}</Button>{c.protected_periods?.map((p) => <span key={p.lifecycle_event_id}>{p.article}</span>)}{aside}</div> }));
vi.mock("./exit-close", () => ({ CloseForm: () => null }));
vi.mock("./exit-report", () => ({ ReportForm: () => null }));
vi.mock("./exit-facts", () => ({ RelDay: () => null }));

beforeAll(() => loadCatalog("ko"));

test.each([undefined, "exit.report"])("receipt space is reserved only for an open report (%s)", (act) => {
  reads.cases = [];
  const html = renderToStaticMarkup(<ExitCases employee={{ id: "person", name: "한기록", status: "ACTIVE" } as components["schemas"]["Employee"]} act={act} />);
  expect(html.includes(s.receiptSlot!)).toBe(act === "exit.report");
});

function sheet(detail?: Case, error: Error | null = null) {
  const c = { id: "case-1", status: "REPORTED", effective_exit_date: "2026-10-21", protected_periods: [] } as unknown as Case;
  reads.cases = [c];
  reads.detail = detail;
  reads.error = error;
  return renderToStaticMarkup(<ExitCases employee={{ id: "person-1", name: "Synthetic employee", status: "ACTIVE" } as components["schemas"]["Employee"]} act="exit.confirm_exit:case-1" />);
}

test("the HR sheet opens from its list row while the detail read is pending", () => {
  expect(sheet()).toContain('role="dialog">case-1');
  expect(sheet()).toMatch(/<button[^>]*disabled=""/);
});

test("the HR sheet refines the list row with the authorized protected periods", () => {
  const detail = { id: "case-1", protected_periods: [{ lifecycle_event_id: "leave-1", article: "제23조제2항" }] } as unknown as Case;
  expect(sheet(detail)).toContain("제23조제2항");
  expect(sheet(detail)).not.toMatch(/<button[^>]*disabled=/);
});

test("a failed case-detail read keeps confirmation disabled and offers its retry", () => {
  const html = sheet(undefined, new Error("detail unavailable"));
  expect(html).toMatch(/<button[^>]*disabled=""/);
  expect(html).toContain(t("common.retry"));
  reads.error = null;
});


test("a same-day last working day displays tomorrow as the scheduled retirement date", () => {
  reads.cases = [{ id: "scheduled", status: "HR_CONFIRMED", effective_exit_date: "2026-10-24", exit_event_state: "SCHEDULED" }];
  const html = renderToStaticMarkup(<ExitCases employee={{ id: "person", name: "경계직원", status: "ACTIVE" } as components["schemas"]["Employee"]} />);
  expect(html).toContain("2026. 10. 25. 퇴직");
  expect(html).toContain("2026. 10. 25.에 퇴직 처리가 반영됩니다");
  expect(html).not.toContain("2026. 10. 24. 퇴직");
});

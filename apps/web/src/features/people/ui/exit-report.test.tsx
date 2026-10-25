// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ReportForm } from "./exit-report";

const draft = vi.hoisted(() => ({
  value: { date: "", note: "", reason: null as string | null }, restored: false, problem: null as string | null,
  set: vi.fn(), discard: vi.fn(),
}));
const scenario = vi.hoisted(() => ({ fields: false, error: null as Error | null, submit: vi.fn(), queries: [] as { fixture?: string; input?: unknown[]; enabled?: boolean }[] }));
vi.mock("../../../lib/react/use-draft", () => ({ useDraft: () => draft }));
vi.mock("@tanstack/react-query", () => ({ useQuery: (q: { fixture?: string; input?: unknown[]; enabled?: boolean }) => {
  scenario.queries.push(q);
  const path = q.fixture ?? "";
  const data = path === "guards" ? {
    protected_periods: [{ lifecycle_event_id: "leave", leave_type: "CHILDCARE", leave_from: "2026-10-01", leave_until: "2026-11-30", protected_until: "2026-11-30", instrument: "남녀고용평등법", article: "제19조제3항" }],
    notice_required: true, refusal_code: "exit_protected_period", notice_pay: null,
  } : path === "reasons" ? { items: [
    { code: "PERSONAL", system: true, active: true, requires_note: false, involuntary: false, notice_required: false },
    { code: "DISCIPLINARY_DISMISSAL", system: true, active: true, requires_note: false, involuntary: true, notice_required: true },
  ] } : { items: [] };
  return { isPending: false, isError: path === "guards" && Boolean(scenario.error), error: path === "guards" ? scenario.error : null, data: path === "guards" && scenario.error ? undefined : data, refetch: vi.fn() };
}, useQueries: () => [{ isPending: false, data: [{ item_key: "X12", label: "이직확인서 발급", kind: "DOC", due_rule_kind: "UNKNOWN", legal_review_required: true }] }] }));
vi.mock("../api", async (original) => ({
  ...await original<typeof import("../api")>(),
  eventsQuery: () => ({ fixture: "events" }),
  exitGuardsQuery: (...input: unknown[]) => ({ fixture: "guards", input }),
}));
vi.mock("../../../lib/reason-codes", async (original) => ({
  ...await original<typeof import("../../../lib/reason-codes")>(),
  reasonCodesQuery: () => ({ fixture: "reasons" }),
  useExitClass: (code: string) => ({ involuntary: code === "DISCIPLINARY_DISMISSAL" }),
}));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }) }));
vi.mock("./use-exit-command", () => ({ useExitCommand: () => ({ pending: false, locked: false, submit: scenario.submit }) }));
vi.mock("./account-link-card", () => ({ OpsExitNote: () => null }));
vi.mock("./exit-foot", () => ({ StepFrame: ({ sheet, note, aside, sections, children }: { sheet: { kicker?: ReactNode; subtitle?: ReactNode }; note?: ReactNode; aside?: ReactNode; sections?: Record<string, ReactNode>; children?: ReactNode }) => <>{sheet.kicker}{sheet.subtitle}{note}{aside}{Object.values(sections ?? {})}{scenario.fields && children}</> }));

const employee = { id: "person", name: "김초안", employee_number: "REC-1", org_unit: "본점", position: "팀장" } as ComponentProps<typeof ReportForm>["employee"];
const render = () => renderToStaticMarkup(<ReportForm employee={employee} onClose={() => undefined} onDone={() => undefined} />);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  draft.restored = false; draft.problem = null;
  draft.value = { date: "", note: "", reason: null };
  scenario.fields = false; scenario.error = null; scenario.queries = []; scenario.submit.mockClear();
});

test("reporting an exit previews its case paperwork through the composer sections", () => {
  const html = render();
  expect(html).toContain("이직확인서 발급");
  expect(html).toContain(t("lifecycle.trail.unverified"));
});

test("an untouched form adds no draft feedback to the existing note and actions", () => {
  const html = render();
  expect(html).not.toContain(t("draft.restored"));
  expect(html).not.toContain(t("draft.unavailable"));
  expect(html).not.toContain(t("draft.discard"));
  for (const fact of [employee.name, employee.employee_number!, employee.org_unit!, employee.position!]) {
    expect(html.split(fact)).toHaveLength(2);
  }
});

test("a restored draft uses the form note and secondary discard action", () => {
  draft.restored = true;
  const html = render();
  expect(html).toContain(`<output>${t("draft.restored")}</output>`);
  expect(html).toContain(t("draft.discard"));
});

test.each(["unreadable", "unavailable"])("%s storage takes priority in the form note", (problem) => {
  draft.restored = true;
  draft.problem = problem;
  const html = render();
  expect(html).toContain(`<output>${t("draft.unavailable")}</output>`);
  expect(html).not.toContain(t("draft.restored"));
  expect(html).not.toContain(t("draft.discard"));
});

test("dismissal preflight shows its protected period and article before submit, with grouped reasons", () => {
  scenario.fields = true;
  draft.value = { date: "2026-11-06", note: "합성 경위", reason: "DISCIPLINARY_DISMISSAL" };
  const html = render();
  expect(html).toContain("이직확인서 발급");
  expect(html).toContain(t("exit.error.exit_protected_period"));
  expect(html.indexOf("</textarea>")).toBeLessThan(html.indexOf(t("exit.error.exit_protected_period")));
  expect(html).toContain(t("exit.protection.title"));
  expect(html).toContain("남녀고용평등법 제19조제3항");
  expect(html).toContain(t("exit.notice.title"));
  expect(html).toContain(t("exit.class.voluntary"));
  expect(html).toContain(t("exit.class.involuntary"));
  expect(html.indexOf(t("exit.class.voluntary"))).toBeLessThan(html.indexOf(t("reason.exit_reason.PERSONAL")));
  expect(html.indexOf(t("exit.class.involuntary"))).toBeLessThan(html.indexOf(t("reason.exit_reason.DISCIPLINARY_DISMISSAL")));
  expect(scenario.submit).not.toHaveBeenCalled();
  expect(scenario.queries.find((q) => q.fixture === "guards")).toMatchObject({
    enabled: true,
    input: ["person", "2026-11-06", "DISCIPLINARY_DISMISSAL"],
  });
});

test("an unavailable preflight names the failed read and retains a retry", () => {
  scenario.fields = true;
  scenario.error = new Error("preflight unavailable");
  draft.value = { date: "2026-11-06", note: "합성", reason: "DISCIPLINARY_DISMISSAL" };
  const html = render();
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain(t("exit.protection.title"));
  expect(scenario.submit).not.toHaveBeenCalled();
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ReportForm } from "./exit-report";

const draft = vi.hoisted(() => ({
  value: { date: "", note: "", reason: null }, restored: false, problem: null as string | null,
  set: vi.fn(), discard: vi.fn(),
}));
vi.mock("../../../lib/react/use-draft", () => ({ useDraft: () => draft }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isPending: false, data: { items: [] } }) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useNavigate: () => vi.fn() }) }));
vi.mock("./use-exit-command", () => ({ useExitCommand: () => ({ pending: false, locked: false }) }));
vi.mock("./account-link-card", () => ({ OpsExitNote: () => null }));
vi.mock("./exit-foot", () => ({ StepFrame: ({ sheet, note, aside }: { sheet: { kicker?: ReactNode; subtitle?: ReactNode }; note?: ReactNode; aside?: ReactNode }) => <>{sheet.kicker}{sheet.subtitle}{note}{aside}</> }));

const employee = { id: "person", name: "김초안", employee_number: "REC-1", org_unit: "본점", position: "팀장" } as ComponentProps<typeof ReportForm>["employee"];
const render = () => renderToStaticMarkup(<ReportForm employee={employee} onClose={() => undefined} onDone={() => undefined} />);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { draft.restored = false; draft.problem = null; });

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

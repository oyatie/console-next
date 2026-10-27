// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { EMPTY } from "../domain/register";
import { RosterFilters } from "./roster-filters";
import { RunTable } from "./register-run-table";
import { RegisterRun } from "./register-run-page";
import { NoticeListPage } from "./notice-list-page";
import { RosterHead } from "./roster-head";
import { ExitPeek } from "./exit-peek";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <span data-to={to}>{children}</span>,
  getRouteApi: () => ({ useNavigate: () => vi.fn(), useRouteContext: () => ({ peopleAccess: { unplaced: { domain: "hr_basic", level: "edit", tenant: true } } }) }), useNavigate: () => vi.fn(),
}));
vi.mock("./roster-scope", () => ({ RosterScope: () => null }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ isSuccess: true, isPending: false, error: null, data: { items: [], entities: [], entries: [], phase: "SETUP", capabilities: [{ feature: "employee_directory_manage", permission: "allow", org_wide: true }] } }) }));
vi.mock("./use-register", () => ({ useRegister: () => ({ mutate: vi.fn() }), useUndoRegister: () => ({ mutate: vi.fn() }) }));
vi.mock("./register-toast", () => ({ RegisterToast: () => null }));
beforeAll(() => loadCatalog("ko"));

function filters(identity: number) {
  return renderToStaticMarkup(<RosterFilters status="current" review={[]} counts={{
    status: { totals: { current: 4, ACTIVE: 2, ON_LEAVE: 1, PRE_HIRE: 1, UNKNOWN: 0, EXITED: 0, all: 4 }, failed: [] },
    review: { totals: { department: 0, contractPast: 0, contractSoon: 3, identity, unplaced: 4, register: 2, failed: 0 }, failed: [] },
  }} onChange={() => {}} findSlot={() => {}} density="regular" onDensity={() => {}} />);
}

test("review chips omit zero counts and concepts already represented by views", () => {
  const html = filters(2);
  expect(html).toContain(t("roster.review.identity"));
  for (const key of ["contractPast", "contractSoon", "unplaced", "register", "failed"] as const) {
    expect(html).not.toContain(`title="${t(`roster.review.${key}.title`, { days: 60 })}`);
  }
  expect(filters(0)).not.toContain('id="roster-review"');
});

test("continuous registration has visible glossary column names and submit verb", () => {
  const html = renderToStaticMarkup(<RunTable rows={[]} showAll={false} onShowAll={() => {}} d={EMPTY} set={() => {}} hireText="" onHire={() => {}} today="2026-10-25" places={[]} carried={() => false} invalid={new Set()} undoable={false} onUndo={() => {}} onSave={() => {}} />);
  expect(html).toContain(">소속</th>");
  expect(html).toContain(">작업</th>");
  expect(html).toMatch(/<button[^>]*>등록\s*<kbd/);
});

test("exit peek contains only served actions", () => {
  const html = renderToStaticMarkup(<ExitPeek id="employee" exitDate="2026-10-20" today="2026-10-25" />);
  expect(html).not.toContain("퇴직 되돌리기");
  expect(html).not.toContain("아직");
});

test("an empty registration run has one heading and no completion command", () => {
  const html = renderToStaticMarkup(<RegisterRun />);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).not.toContain(">완료");
  expect(html).toContain(">등록 ");
});

test("the notices list offers its own primary composer entry", () => {
  const html = renderToStaticMarkup(<NoticeListPage />);
  expect(html).toContain('data-to="/people/notices/new"');
  expect(html).toContain(">공고 작성</span>");
  expect(html).not.toContain("받은 기록에서");
});


test("the roster head delegates one export and shows its date as a fact", () => {
  const html = renderToStaticMarkup(<RosterHead manage status="current" review={[]} onView={() => {}} actions={<Button>{t("roster.export")}</Button>} />);
  expect(html).toContain(">내보내기</button>");
  expect(html).not.toContain('export=');
  expect(html).not.toContain(t("roster.head.register"));
  expect(html).not.toContain('aria-disabled="true"');
  expect(html).not.toContain("아직 열지 않았");
});

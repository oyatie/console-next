// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { OrgChanges } from "./org-changes";
const state = vi.hoisted(() => ({ counts: "success", mine: "success", total: 0 }));
const query = (status: string) => ({ data: status === "success" ? { items: [], total: state.total } : undefined, isSuccess: status === "success", isError: status === "error", isPending: status === "pending" });
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({ effective_from: "2026-11-01", effective_to: "2026-11-30" }), useNavigate: () => vi.fn() }), Link: ({ children }: { children: import("react").ReactNode }) => <span>{children}</span> }));
vi.mock("@tanstack/react-query", () => ({ keepPreviousData: vi.fn(), useQueries: () => Array.from({ length: 6 }, () => query(state.counts)), useQuery: () => query(state.mine) }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: () => null }));
vi.mock("./use-change-names", () => ({ useChangeNames: () => ({}) }));
vi.mock("./use-org-routed", () => ({ useOrgRouted: () => false }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.counts = "success"; state.mine = "success"; state.total = 0; });
test("the removable period filter shows both dates", () => {
  const html = renderToStaticMarkup(<OrgChanges />);
  expect(html).toContain("2026. 11. 01.");
  expect(html).toContain("2026. 11. 30.");
  expect(html).toContain("기간 조건 초기화");
});

test.each(["pending", "error"])("%s tab counts never claim there are zero changes", status => {
  state.counts = status;
  const html = renderToStaticMarkup(<OrgChanges />);
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).not.toMatch(/(?:진행 중|내가 쓴 변경|예정|완료|취소|전체)\s*0/);
  if (status === "error") expect(text).toContain("—");
  else expect(html).toContain('aria-hidden="true"');
});

test.each(["pending", "error"])("the open count stays unknown while personal redrafts are %s", status => {
  state.mine = status;
  const text = renderToStaticMarkup(<OrgChanges />).replace(/<[^>]*>/g, "");
  expect(text).not.toMatch(/진행 중\s*0/);
});

test.each([0, 2000])("successful tab counts still show the server total %i", total => {
  state.total = total;
  const text = renderToStaticMarkup(<OrgChanges />).replace(/<[^>]*>/g, "");
  expect(text).toMatch(new RegExp(`전체\\s*${total.toLocaleString("ko-KR")}`));
});

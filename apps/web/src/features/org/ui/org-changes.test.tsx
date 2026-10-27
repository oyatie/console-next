// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { useQuery } from "@tanstack/react-query";
import { OrgChanges } from "./org-changes";
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({ effective_from: "2026-11-01", effective_to: "2026-11-30" }), useNavigate: () => vi.fn() }), Link: ({ children }: { children: import("react").ReactNode }) => <span>{children}</span> }));
const state = vi.hoisted(() => ({
  counts: { data: undefined as Record<string, number> | undefined, isError: false, isPending: true, error: null as unknown },
  list: { data: { items: [], total: 0 }, isError: false, isPending: false, isPlaceholderData: false, error: null as unknown },
  mine: { data: { items: [], total: 0 } as { items: []; total: number } | undefined, isError: false },
}));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: vi.fn(),
  useQueries: () => Array.from({ length: 7 }, () => state.counts),
  useQuery: vi.fn(),
}));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ q }: { q: { isError: boolean } }) => q.isError ? <div role="alert" /> : null }));
vi.mock("./use-change-names", () => ({ useChangeNames: () => ({}) }));
vi.mock("./use-org-routed", () => ({ useOrgRouted: () => false }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  vi.mocked(useQuery).mockReset().mockImplementationOnce(() => state.counts as never).mockImplementationOnce(() => state.list as never).mockImplementation(() => state.mine as never);
  Object.assign(state.counts, { data: undefined, isError: false, isPending: true, error: null });
  Object.assign(state.list, { isError: false, isPending: false, isPlaceholderData: false, error: null });
  Object.assign(state.mine, { data: { items: [], total: 0 }, isError: false });
});
test("the removable period filter shows both dates", () => {
  const html = renderToStaticMarkup(<OrgChanges />);
  expect(html).toContain("2026. 11. 01.");
  expect(html).toContain("2026. 11. 30.");
  expect(html).toContain("기간 조건 초기화");
});
const tabs = () => renderToStaticMarkup(<OrgChanges />).match(/<div role="group"[^>]*>(.*?)<\/div>/s)![1]!;
test("loading counts never render a digit in the tabs", () => {
  expect(tabs().replace(/<[^>]+>/g, "")).not.toMatch(/\d/);
});
test("failed counts show the shared failed marker instead of zero", () => {
  Object.assign(state.counts, { data: { open: 0, mine: 0, approval: 0, ready: 0, done: 0, closed: 0, all: 0 }, isError: true, isPending: false, error: new Error("count read failed") });
  const html = tabs();
  expect(html.replace(/<[^>]+>/g, "")).not.toMatch(/\d/);
  expect(html).toContain("—</span>");
  expect(html).toContain("title=");
  expect(html).not.toContain('aria-disabled="true"');
});
test.each(["loading", "failed"])("a %s list keeps every tab inert with a reason", (status) => {
  Object.assign(state.list, { isPending: status === "loading", isError: status === "failed" });
  const html = tabs();
  expect(html.match(/aria-disabled="true"/g)).toHaveLength(6);
  expect(html.match(/aria-describedby=/g)).toHaveLength(6);
  const reason = t(status === "failed" ? "orgChange.list.viewsUnavailable" : "common.loading");
  expect(html.split(reason)).toHaveLength(2);
  expect(html).not.toContain(t("common.loadFailed.title"));
});
test("a background view change keeps tabs usable while the previous page is visible", () => {
  state.list.isPlaceholderData = true;
  expect(tabs()).not.toContain('aria-disabled="true"');
});
test.each([false, true])("a failed mine read marks only the open count failed with cached data %s", cached => {
  state.counts.data = { open: 2, mine: 3, approval: 0, ready: 1, done: 1, closed: 0, all: 3 };
  Object.assign(state.mine, { data: cached ? { items: [], total: 0 } : undefined, isError: true });
  const html = tabs();
  expect(html.match(/—<\/span>/g)).toHaveLength(1);
  expect(html).toContain(`title="${t("orgChange.list.countFailed")}"`);
  expect(html).not.toContain('aria-hidden="true"');
  expect(html).not.toContain('aria-disabled="true"');
});
test.each([false, true])("failed counts show one error region when the list failure is %s", failedList => {
  Object.assign(state.counts, { isError: true, isPending: false, error: new Error("count read failed") });
  Object.assign(state.list, { isError: failedList });
  const html = renderToStaticMarkup(<OrgChanges />);
  expect(html.match(/role="alert"/g)).toHaveLength(1);
  expect(html.match(/—<\/span>/g)).toHaveLength(6);
});

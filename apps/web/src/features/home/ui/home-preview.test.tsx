// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { Home } from "../Home";
import type { AttentionInboxResponse } from "../domain/inbox-filter";

const view = vi.hoisted(() => ({ pages: [] as AttentionInboxResponse[] }));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: { display_name: "사용자" } }),
  useInfiniteQuery: () => ({ data: { pages: view.pages }, isPending: false, isFetching: false, error: null, hasNextPage: true }),
}));
function page(count: number, prefix = "preview"): AttentionInboxResponse {
  return {
    items: Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, kind: "register_review", lane: "turn", title: `${prefix}-${i}`, ref: "", urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [] })),
    total: count, total_is_exact: true, next_cursor: "cursor", unavailable: [], available_filters: ["turn", "scheduled"],
    counts: { turn: { total: count, total_is_exact: false }, scheduled: { total: 0, total_is_exact: true } }, upcoming: [], has_work: true, quick_starts: [], as_of: "2026-10-27T00:00:00Z",
  };
}
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.pages = [page(7), page(1, "later-page")]; });
const html = () => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}><Home /></RouterContextProvider>);
};
test("Home keeps the first queue page without duplicating the full inbox views", () => {
  const markup = html();
  expect(markup.match(/<tr data-id=/g)).toHaveLength(5);
  expect(markup).not.toContain("later-page");
  expect(markup).not.toContain(t("home.inbox.more"));
  expect(markup).toContain(`href="/inbox">${t("home.inbox.viewInbox")}`);
});

test("Home offers server-counted attention filters in place", () => {
  view.pages = [{
    ...page(7),
    attention_filters: [
      { key: "all", total: 7, total_is_exact: true },
      { key: "approvals", total: 2, total_is_exact: true },
      { key: "today", total: 1, total_is_exact: true },
      { key: "overdue", total: 1, total_is_exact: false },
      { key: "future", total: 99, total_is_exact: true } as never,
    ],
  }];
  const markup = html();
  for (const label of ["전체", "결재", "오늘", "기한 지남"]) expect(markup).toContain(`>${label}<`);
  expect(markup).toContain('aria-pressed="true"');
  expect(markup).toContain("1+");
  expect(markup).not.toContain("home.attention.future");
  expect(markup).not.toContain('href="/inbox?tab=scheduled"');
  expect(markup).toContain(`href="/inbox">${t("home.inbox.viewInbox")}`);
});

test.each([
  [false, [], false],
  [false, ["waiting"], true],
  [true, [], true],
] as const)("Home offers the inbox and attention chips only when it serves work or a personal filter (%s, %j)", (hasWork, filters, visible) => {
  view.pages = [{ ...page(0), has_work: hasWork, available_filters: [...filters], attention_filters: [{ key: "all", total: 0, total_is_exact: true }] }];
  const markup = html();
  expect(markup.includes('href="/inbox"')).toBe(visible);
  expect(markup.includes(`aria-label="${t("home.attention.label")}"`)).toBe(visible);
});

test.each([
  { state: "absent", attention_filters: undefined },
  { state: "empty", attention_filters: [] },
])("Home keeps server-counted lane links when attention filters are $state", ({ attention_filters }) => {
  view.pages = [{ ...page(7), attention_filters, available_filters: ["turn", "scheduled", "waiting", "deadlines", "failures"], counts: {
    turn: { total: 31, total_is_exact: false }, scheduled: { total: 0, total_is_exact: true },
    waiting: { total: 2, total_is_exact: true }, deadlines: { total: 1, total_is_exact: true }, failures: { total: 0, total_is_exact: true },
  } }];
  const markup = html();
  expect(markup).toContain(`aria-label="${t("home.lanes")}"`);
  expect(markup).not.toContain(`aria-label="${t("home.attention.label")}"`);
  const lanes = markup.match(/<nav[^>]*>[\s\S]*?<\/nav>/)![0];
  expect(lanes).not.toContain('aria-current="page"');
  expect(lanes).toContain('aria-current="true"');
  for (const key of view.pages[0]!.available_filters) {
    const count = view.pages[0]!.counts[key]!;
    const label = t(count.total_is_exact ? "home.inbox.filterCount" : "home.inbox.filterCount.lower", { filter: t(`home.inbox.filter.${key}`), count: count.total });
    // My turn and its due-soon slice open 해야 할 일, the inbox's first tab.
    expect(lanes).toContain(key === "turn" || key === "deadlines" ? `href="/inbox">${label}` : `href="/inbox?tab=${key}"`);
    expect(markup).toContain(label);
  }
});

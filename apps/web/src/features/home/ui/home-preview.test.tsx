// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { components } from "@console/api/schema";
import { Home } from "../Home";

const view = vi.hoisted(() => ({ pages: [] as components["schemas"]["ActionInboxResponse"][] }));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: { display_name: "사용자" } }),
  useInfiniteQuery: () => ({ data: { pages: view.pages }, isPending: false, isFetching: false, error: null, hasNextPage: true }),
}));
function page(count: number, prefix = "preview"): components["schemas"]["ActionInboxResponse"] {
  return {
    items: Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, kind: "register_review", lane: "turn", title: `${prefix}-${i}`, ref: "", urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [] })),
    total: count, total_is_exact: true, next_cursor: "cursor", unavailable: [], available_filters: ["turn", "scheduled"], counts: {}, upcoming: [], has_work: true, quick_starts: [], as_of: "2026-10-27T00:00:00Z",
  };
}
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { view.pages = [page(7), page(1, "later-page")]; });
const html = () => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}><Home /></RouterContextProvider>);
};
test("Home shrinks the shared queue to the first page with no filters or cursor button", () => {
  const markup = html();
  expect(markup.match(/<tr data-id=/g)).toHaveLength(5);
  expect(markup).not.toContain("later-page");
  expect(markup).not.toContain(t("home.inbox.more"));
  expect(markup).not.toContain(t("home.inbox.filter.scheduled"));
  expect(markup).toContain('href="/inbox"');
});

test.each([
  [false, [], false],
  [false, ["waiting"], true],
  [true, [], true],
] as const)("Home offers the inbox only when it serves work or a personal filter (%s, %j)", (hasWork, filters, visible) => {
  view.pages = [{ ...page(0), has_work: hasWork, available_filters: [...filters] }];
  expect(html().includes('href="/inbox"')).toBe(visible);
});

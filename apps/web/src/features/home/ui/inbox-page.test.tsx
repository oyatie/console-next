// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { cursorPages, readIdentity } from "../../../lib/query";
import cardCss from "../../../ui/card/card.module.css";
import { InboxPage } from "./inbox-page";

type Page = components["schemas"]["ActionInboxResponse"];
type Options = ReturnType<typeof cursorPages<"/api/v1/me/action-inbox">>;
const view = vi.hoisted(() => ({
  options: undefined as Options | undefined,
  phase: "OPERATING" as "SETUP" | "OPERATING",
  list: { isPending: false, isFetching: false, dataUpdatedAt: 1, error: null as unknown, data: undefined as { pages: Page[] } | undefined, hasNextPage: false, isFetchingNextPage: false },
}));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: Parameters<typeof readIdentity>[0]) => ({
    data: JSON.parse(readIdentity(options))[0] === "/api/v1/users/me" ? { display_name: "사용자", tenant: { name: "검증법인", phase: view.phase, go_live_at: null } } : undefined,
    isPending: false, isFetching: false, isFetchedAfterMount: true, isError: false, isSuccess: true, dataUpdatedAt: 1,
  }),
  useInfiniteQuery: (options: Options) => { view.options = options; return { ...view.list, fetchNextPage: vi.fn(), refetch: vi.fn() }; },
}));
vi.mock("../../../lib/live/live", async original => ({ ...await original<typeof import("../../../lib/live/live")>(), liveApplying: { get: () => false, subscribe: () => () => {} }, holdLive: () => () => {} }));

const samplePage = (extra: Partial<Page> = {}): Page => ({
  items: [{ id: "row-1", kind: "register_review", lane: "turn", title: "명부 확인", ref: "", urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [{ kind: "employee", id: "row-1" }] }],
  total: 1, total_is_exact: true, next_cursor: null, unavailable: [], available_filters: ["turn", "waiting"],
  counts: { turn: { total: 1, total_is_exact: true } }, upcoming: [], has_work: true, quick_starts: [], as_of: "2026-10-23T00:00:00Z", ...extra,
});
const html = (url = "/inbox") => {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: [url] }) });
  return renderToStaticMarkup(<RouterContextProvider router={router}><InboxPage /></RouterContextProvider>);
};

beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  view.options = undefined;
  view.phase = "OPERATING";
  view.list = { isPending: false, isFetching: false, dataUpdatedAt: Date.now() + 1_000, error: null, data: { pages: [samplePage()] }, hasNextPage: false, isFetchingNextPage: false };
});

test("InboxPage defaults to filter=all while /inbox?tab=turn addresses my turn", () => {
  html("/inbox");
  expect(JSON.parse(readIdentity(view.options!))).toEqual(["/api/v1/me/action-inbox", { query: { filter: "all" } }, "cursor"]);
  html("/inbox?tab=turn");
  expect(JSON.parse(readIdentity(view.options!))).toEqual(["/api/v1/me/action-inbox", { query: { filter: "turn" } }, "cursor"]);
});

test.each([false, true])("an empty inbox with an unavailable source stays partial (has_work=%s)", has_work => {
  view.list.data = { pages: [samplePage({ items: [], total: 0, has_work, unavailable: [{ source: "support_access", support_reference: "support-reference" }] })] };
  const partial = html();
  expect(partial).toContain(t("home.empty.partial.title"));
  expect(partial).not.toContain(t("home.noWork.title"));
  expect(partial).not.toContain(t("home.inbox.empty.title"));
});

test("InboxPage places as-of in the page head and never mounts a headless card header", () => {
  const ready = html();
  const timeAt = ready.indexOf("<time");
  expect(timeAt).toBeGreaterThan(-1);
  expect(timeAt).toBeLessThan(ready.indexOf("<section"));
  expect(ready).not.toContain(cardCss.head);

  view.list = { ...view.list, isPending: true, data: undefined };
  const loading = html();
  expect(loading).not.toContain('data-bone="short"');
  expect(loading).not.toContain("<time");
  expect(loading).not.toContain(cardCss.head);

  view.list = { ...view.list, isPending: false, error: new Error("unavailable"), data: undefined };
  const failed = html();
  expect(failed).toContain(t("common.loadFailed.title"));
  expect(failed).not.toContain("<time");
  expect(failed).not.toContain(cardCss.head);

  view.phase = "SETUP";
  view.list = { ...view.list, error: null, data: { pages: [samplePage()] } };
  const setup = html();
  expect(setup).not.toContain("<time");
  expect(setup).not.toContain(cardCss.head);
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import { createElement, type MouseEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import type { Checklist } from "@console/api/pending";
import { loadCatalog, t } from "@console/i18n";
import type { Button } from "../../../ui/button/button";
import { Home } from "../Home";
import { cursorPages, readIdentity } from "../../../lib/query";

type Item = components["schemas"]["ActionInboxItem"];
type Page = components["schemas"]["ActionInboxResponse"];
type Options = ReturnType<typeof cursorPages<"/api/v1/me/action-inbox">>;
const view = vi.hoisted(() => ({
  get: vi.fn(), filter: "turn", reads: [] as string[], options: undefined as Options | undefined,
  buttons: [] as Parameters<typeof Button>[0][], next: vi.fn(), retry: vi.fn(),
  list: { isPending: false, error: null as unknown, data: undefined as { pages: Page[] } | undefined, hasNextPage: false, isFetchingNextPage: false },
}));
vi.mock("@console/api", async (original) => {
  const actual = await original<typeof import("@console/api")>();
  return { ...actual, api: { ...actual.api, GET: (...args: unknown[]) => view.get(...args) } };
});
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => initial === "turn" ? [view.filter, (filter: string) => { view.filter = filter; }] : actual.useState(initial) };
});
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: Parameters<typeof readIdentity>[0]) => {
    view.reads.push(String(JSON.parse(readIdentity(options))[0]));
    return { data: JSON.parse(readIdentity(options))[0] === "/api/v1/branches" ? [] : { display_name: "사용자", capabilities: [], items: [], is_ops: true }, isPending: false, isFetching: false, isError: false, isSuccess: true, dataUpdatedAt: 1 };
  },
  useQueries: ({ queries }: { queries: Parameters<typeof readIdentity>[0][] }) => queries.map((query) => {
    view.reads.push(String(JSON.parse(readIdentity(query))[0]));
    return { data: { items: [], total: 0 }, isPending: false, isFetching: false, isError: false, isSuccess: true, dataUpdatedAt: 1 };
  }),
  useInfiniteQuery: (options: Options) => { view.options = options; return { ...view.list, fetchNextPage: view.next, refetch: view.retry }; },
}));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({}) }));
vi.mock("../../../ui/button/button", async (original) => {
  const actual = await original<typeof import("../../../ui/button/button")>();
  return { ...actual, Button: (props: Parameters<typeof Button>[0]) => { view.buttons.push(props); return createElement(actual.Button, props); } };
});
const item = (id: string, extra: Partial<Item> = {}): Item => ({ id, kind: "register_review", lane: "turn", title: id, ref: "", urg: "wait", dueTone: "neutral", done: false, days_remaining: null, links: [{ kind: "employee", id }], ...extra });
const page = (items: Item[], extra: Partial<Page> = {}): Page => ({ items, total: items.length, total_is_exact: true, next_cursor: null, ...extra });
const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory({ initialEntries: ["/"] }) });
const html = () => renderToStaticMarkup(createElement(RouterContextProvider, { router } as Parameters<typeof RouterContextProvider>[0], createElement(() => Home({ setup: (c: Checklist) => createElement("div", { "data-testid": "inbox-setup" }, c.total) }))));
const click = (label: string) => view.buttons.find((button) => button.children === label)!.onClick!({} as MouseEvent<HTMLButtonElement>);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  vi.restoreAllMocks(); vi.clearAllMocks();
  view.filter = "turn"; view.reads = []; view.options = undefined; view.buttons = [];
  view.list = { isPending: false, error: null, data: { pages: [page([item("명부 확인")])] }, hasNextPage: false, isFetchingNextPage: false };
});

test("Home reads all work through the unified inbox and renders its record verb", () => {
  const markup = html();
  expect(JSON.parse(readIdentity(view.options!))).toEqual(["/api/v1/me/action-inbox", { query: { filter: "turn" } }, "cursor"]);
  expect(view.reads.filter((path) => path !== "/api/v1/users/me")).toEqual([]);
  expect(markup).toContain("명부 확인");
  expect(markup).toContain('href="/people/');
  expect(markup).toContain(t("home.inbox.reason.register"));
});

test.each(["waiting", "scheduled", "deadlines", "failures"] as const)("%s requests the server filter", (filter) => {
  html();
  click(t(`home.inbox.filter.${filter}`));
  html();
  expect(JSON.parse(readIdentity(view.options!))[1]).toEqual({ query: { filter } });
});

test("more work follows the server cursor without an offset or a polling interval", async () => {
  view.list.hasNextPage = true;
  html();
  click(t("home.inbox.more"));
  expect(view.next).toHaveBeenCalledOnce();
  expect(view.options!.getNextPageParam(page([], { next_cursor: "stable-cursor" }))).toBe("stable-cursor");
  const response = page([item("next")]);
  const get = view.get.mockResolvedValue({ data: response, response: new Response() });
  await view.options!.queryFn({ pageParam: "stable-cursor" });
  expect(get).toHaveBeenCalledWith("/api/v1/me/action-inbox", { params: { query: { filter: "turn", cursor: "stable-cursor" } } });
});

test("a refreshed response removes resolved rows and keeps loaded cursor pages", () => {
  view.list.data = { pages: [page([item("resolved")]), page([item("still waiting")])] };
  expect(html()).toContain("resolved");
  view.list.data = { pages: [page([]), page([item("still waiting")])] };
  const refreshed = html();
  expect(refreshed).not.toContain("resolved");
  expect(refreshed).toContain("still waiting");
});

test("deadlines use the server's remaining days", () => {
  view.list.data = { pages: [page([item("dated", { due: "2099-01-01T00:00:00Z", days_remaining: 3, dueTone: "warn" })])] };
  expect(html()).toContain("D-3");
});

test("a statutory inbox item opens the filing list for its own lifecycle event", () => {
  const event = "ecdf082c-c28e-4e9f-b6bb-9c4187d8d6fd";
  view.list.data = { pages: [page([item("신고 대상", { kind: "insurance_filing", links: [{ kind: "statutory", id: event }] })])] };
  expect(html()).toContain(`href="/statutory?event=${event}"`);
});

test("a failed inbox read shows retry without claiming the queue is empty", () => {
  view.list.error = new Error("source unavailable"); view.list.data = undefined;
  const markup = html();
  expect(markup).toContain(t("common.loadFailed.title"));
  expect(markup).not.toContain(t("home.inbox.empty.title"));
  click(t("common.retry"));
  expect(view.retry).toHaveBeenCalledOnce();
});

test("setup work uses its server checklist once inside the inbox", () => {
  const setup: Checklist = { phase: "SETUP", steps: [], done: 0, total: 1, go_live_at: null, summary: { people: 0, placed: 0, unplaced: 0, entity_unknown: 0, progress: 0 } };
  view.list.data = { pages: [page([item("duplicated setup", { kind: "setup_entity" })], { setup })] };
  const markup = html();
  expect(markup.match(/data-testid="inbox-setup"/g)).toHaveLength(1);
  expect(markup).not.toContain("duplicated setup");
  expect(markup.indexOf('id="inbox-title"')).toBeLessThan(markup.indexOf('data-testid="inbox-setup"'));
});

test("an unregistered record kind stays readable without a guessed destination", () => {
  view.list.data = { pages: [page([item("future work", { links: [{ kind: "future_kind", id: "javascript:bad" }] })])] };
  const markup = html();
  expect(markup).toContain("future work");
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain('href="/people/');
});

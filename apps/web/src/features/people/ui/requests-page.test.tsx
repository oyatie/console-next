// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { queryPath } from "../../../lib/query";
import { RequestsPage } from "./requests-page";

const { state, navigate, buttons, reads } = vi.hoisted(() => ({
  state: {
    loading: false,
    pending: false,
    hr: true,
    experience: "baseline" as "baseline" | "console",
    search: { lane: "all", status: "OPEN", sel: "selected", page: 3 },
  },
  navigate: vi.fn(),
  reads: [] as { path: string; enabled?: boolean }[],
  buttons: new Map<ReactNode, (() => void) | undefined>(),
}));
vi.mock("../../../experience/dom", async importOriginal => ({
  ...await importOriginal<typeof import("../../../experience/dom")>(),
  useActiveExperienceId: () => state.experience,
}));
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => navigate }),
  Link: ({ children, ...rest }: { children: ReactNode } & Record<string, unknown>) => <span data-aria-current={rest["aria-current"]}>{children}</span>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (query: Parameters<typeof queryPath>[0] & { enabled?: boolean }) => {
    const path = queryPath(query);
    reads.push({ path, enabled: query.enabled });
    if (path === "/api/v1/me/authz") return { isLoading: state.loading, isPending: state.pending };
    if (path === "/api/v1/change-requests/counts") return { data: { all: 3, me: 1, role: 2 } };
    return { data: { items: [], offset: 0, total: 0 } };
  },
  useQueries: vi.fn(() => {
    throw new Error("useQueries should not be called by RequestsPage");
  }),
}));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => state.hr }));
vi.mock("../../../lib/react/query-state", () => ({
  QueryState: ({ q, empty, children }: { q: { isLoading?: boolean; data?: { items: [] } }; empty?: (data: { items: [] }) => ReactNode; children?: (data: { items: [] }) => ReactNode }) =>
    q.isLoading ? <span>{t("common.loading")}</span> : (empty?.({ items: [] }) ?? children?.(q.data ?? { items: [] })),
}));
vi.mock("../../../ui/button/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    buttons.set(children, onClick);
    return <span>{children}</span>;
  },
  ToggleButton: ({ children, count }: { children: ReactNode; count?: ReactNode }) => <span>{children}{count}</span>,
}));
vi.mock("../../../ui/count/count", () => ({ Count: ({ n }: { n?: number }) => <bdi data-count={n ?? ""}>{n ?? null}</bdi> }));
vi.mock("@console/i18n", async importOriginal => {
  const actual = await importOriginal<typeof import("@console/i18n")>();
  return { ...actual, t: (key: Parameters<typeof actual.t>[0], args?: { filters?: string }) => key === "requests.none.filtered" ? `${key}:${args?.filters}` : key === "requests.filters.reset" ? key : actual.t(key, args) };
});
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.loading = false;
  state.pending = false;
  state.hr = true;
  state.experience = "baseline";
  reads.length = 0;
  state.search = { lane: "all", status: "OPEN", sel: "selected", page: 3 };
  buttons.clear();
  navigate.mockClear();
});

test.each(["all", "me", "role"] as const)("filtered empty names the effective %s lane and selected status", lane => {
  state.search.lane = lane;
  state.search.status = "DECLINED";
  const html = renderToStaticMarkup(<RequestsPage />);
  expect(html).toContain(t("requests.none.filtered", { filters: `${t(`requests.lane.${lane}`)} · ${t("requests.status.DECLINED")}` }));
  expect(html).toContain(t("requests.filters.reset"));
  expect(html).not.toContain(t("requests.none.hr"));
});

test("mine empty names the person's own requests and ignores an HR lane in the URL", () => {
  state.hr = false;
  state.search.lane = "role";
  const html = renderToStaticMarkup(<RequestsPage />);
  expect(html).toContain(t("requests.none.filtered", { filters: `${t("requests.mine")} · ${t("requests.status.OPEN")}` }));
  expect(html).not.toContain(t("requests.lane.role"));
});

test("reset returns every filter and the selected request to the unfiltered first page", () => {
  state.search.lane = "me";
  renderToStaticMarkup(<RequestsPage />);
  const reset = buttons.get(t("requests.filters.reset"));
  expect(reset).toBeTypeOf("function");
  reset!();
  const navigation = navigate.mock.calls[0]?.[0];
  expect(navigation?.replace).toBe(true);
  expect(navigation?.search(state.search)).toEqual({ lane: "all", status: "ALL", sel: undefined, page: undefined });
});

test.each([true, false])("unfiltered empty preserves the original guidance (HR %s)", hr => {
  state.hr = hr;
  state.search.status = "ALL";
  const html = renderToStaticMarkup(<RequestsPage />);
  expect(html).toContain(t(hr ? "requests.none.hr" : "requests.none.mine"));
  expect(html).not.toContain(t("requests.filters.reset"));
});

test("access loading holds both filter groups, the list read, and counts", () => {
  state.loading = true;
  state.pending = true;
  const html = renderToStaticMarkup(<RequestsPage />);
  expect(html).toContain(t("common.loading"));
  expect(html).not.toContain(t("requests.lane.role"));
  expect(html).not.toContain(t("requests.status.OPEN"));
  expect(reads.find(read => read.path === "/api/v1/change-requests")?.enabled).toBe(false);
  expect(reads.find(read => read.path === "/api/v1/change-requests/counts")?.enabled).toBe(false);
  expect(reads.some(read => read.path.startsWith("/api/v1/employees"))).toBe(false);
});

test.each([false, true])("settled or disabled access keeps the filters and list available (pending %s)", pending => {
  state.pending = pending;
  const html = renderToStaticMarkup(<RequestsPage />);
  expect(html).toContain(t("requests.status.OPEN"));
  expect(html).toContain(t("requests.lane.role"));
  expect(reads.find(read => read.path === "/api/v1/change-requests")?.enabled).toBe(true);
  expect(reads.find(read => read.path === "/api/v1/change-requests/counts")?.enabled).toBe(true);
  expect(html).toContain('data-count="3"');
  expect(html).toContain('data-count="1"');
  expect(html).toContain('data-count="2"');
});

test("non-HR reader keeps changeRequestCountsQuery disabled", () => {
  state.hr = false;
  renderToStaticMarkup(<RequestsPage />);
  expect(reads.find(read => read.path === "/api/v1/change-requests")?.enabled).toBe(true);
  expect(reads.find(read => read.path === "/api/v1/change-requests/counts")?.enabled).toBe(false);
});

test("console experience renders P2 list-record pattern while baseline preserves legacy layout", () => {
  state.experience = "baseline";
  const baselineHtml = renderToStaticMarkup(<RequestsPage />);
  expect(baselineHtml).not.toContain('data-pattern="list-record"');
  expect(baselineHtml).toContain('class="card"');

  state.experience = "console";
  const consoleHtml = renderToStaticMarkup(<RequestsPage />);
  expect(consoleHtml).toContain('data-pattern="list-record"');
  expect(consoleHtml).toContain(t("requests.lane.all"));
  expect(consoleHtml).toContain(">3<");
});

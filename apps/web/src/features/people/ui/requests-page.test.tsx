// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { RequestsPage } from "./requests-page";

const { state, navigate, buttons } = vi.hoisted(() => ({
  state: { hr: true, search: { lane: "all", status: "OPEN", sel: "selected", page: 3 } },
  navigate: vi.fn(),
  buttons: new Map<ReactNode, (() => void) | undefined>(),
}));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => navigate }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [] } }), useQueries: ({ queries }: { queries: unknown[] }) => queries.map(() => ({})) }));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => state.hr }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ empty }: { empty: (data: { items: [] }) => ReactNode }) => empty({ items: [] }) }));
vi.mock("../../../ui/button/button", () => ({
  Button: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => {
    buttons.set(children, onClick);
    return <span>{children}</span>;
  },
  ToggleButton: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../ui/count/count", () => ({ Count: () => null }));
vi.mock("@console/i18n", async importOriginal => {
  const actual = await importOriginal<typeof import("@console/i18n")>();
  return { ...actual, t: (key: Parameters<typeof actual.t>[0], args?: { filters?: string }) => key === "requests.none.filtered" ? `${key}:${args?.filters}` : key === "requests.filters.reset" ? key : actual.t(key, args) };
});
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  state.hr = true;
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

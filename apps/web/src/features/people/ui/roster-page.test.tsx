// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { ApiError, myAccessQuery } from "../../../reference/authz/api";
import { RosterPage } from "./roster-page";
import { rosterWindowQuery } from "../api/roster";
import { VIEWS } from "../domain/roster";

const state = vi.hoisted(() => ({ refused: false, settingsFailed: false, staleWindow: undefined as number | undefined, body: "roster rows", org: false, loading: false, empty: false, search: {} as { status?: string; review?: string; unit?: string; sort?: string } }));
const table = vi.hoisted(() => vi.fn());
const rosterRead = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({ useSearch: () => state.search, useNavigate: () => vi.fn(), useRouteContext: () => ({ peopleAccess: { unplaced: { domain: "hr_basic", level: "edit", tenant: true } } }) }),
  Link: () => null,
  useNavigate: () => vi.fn(),
  useRouter: () => ({ subscribe: vi.fn() }),
  useLocation: () => undefined,
  useElementScrollRestoration: () => undefined,
}));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: { queryFn: unknown }) => options === rosterWindowQuery ? { data: state.settingsFailed ? state.staleWindow : 21, isPending: false, isError: state.settingsFailed, error: state.settingsFailed ? new ApiError(503, "service_unavailable", "") : null, refetch: vi.fn() } : options.queryFn === myAccessQuery.queryFn ? {
    data: { is_ops: false, entries: state.org ? [{ grant_id: "org", domain: "org", level: "view", enforcement: "ENFORCED", scope: { kind: "TENANT" } }] : [] }, isPending: false, error: null,
  } : ({ data: undefined, isPending: false, isFetching: false, isFetchedAfterMount: true, error: new ApiError(403, "access_denied", ""), refetch: vi.fn() }),
}));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => false }));
vi.mock("../../../lib/react/prefetch", () => ({ usePrefetch: () => vi.fn() }));
vi.mock("../../../lib/reason-codes", () => ({ useReasonCodesReady: () => false }));
vi.mock("./roster-table", () => ({ RosterTable: (props: { empty: React.ReactNode }) => { table(props); return <div>{state.empty ? props.empty : state.body}</div>; } }));
vi.mock("./use-roster", async original => ({ ...await original<typeof import("./use-roster")>(), useRoster: (...args: unknown[]) => { rosterRead(...args); return ({
  list: { data: state.refused ? undefined : { pages: [{ items: [], total: 1 }] }, isPending: false, hasNextPage: true, error: state.refused ? new ApiError(403, "access_denied", "") : null, refetch: vi.fn() },
  rows: state.empty ? [] : [{ id: "person", name: "가상직원" }], total: 1, loading: state.loading, status: { totals: { all: 1 }, failed: [] }, review: { totals: {}, failed: [] }, query: {},
}); } }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.refused = false; state.settingsFailed = false; state.staleWindow = undefined; state.org = false; state.loading = false; state.empty = false; state.search = {}; table.mockClear(); rosterRead.mockClear(); });
const render = () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  try { return renderToStaticMarkup(<QueryClientProvider client={client}><RosterPage manage={false} /></QueryClientProvider>); }
  finally { client.clear(); }
};

test("refused organization facets do not replace an admitted roster", () => {
  const html = render();
  expect(html).toContain("roster rows");
  expect(html).not.toContain('aria-label="이 화면에 접근 권한이 없습니다"');
  expect(html).not.toContain("범위 · 전체 · 변경");
  expect(html).not.toContain('data-tone="warn"');
});

test("an unexpected facet refusal never inserts an inline banner into the roster", () => {
  state.org = true;
  const html = render();
  expect(html).toContain("roster rows");
  expect(html).not.toContain('data-tone="warn"');
  expect(html).not.toContain('role="alert"');
});

test("a refused roster read withholds its header, filters and rows", () => {
  state.refused = true;
  const html = render();
  expect(html).toContain('aria-label="이 화면에 접근 권한이 없습니다"');
  expect(html).not.toContain("roster rows");
  expect(html).not.toContain('role="group"');
});

test("the next page is not offered while replacement rows are loading", () => {
  state.loading = true;
  render();
  expect(table).toHaveBeenCalledWith(expect.objectContaining({ hasMore: false }));
});

test.each([false, true])("the unfiltered roster does not offer a filter reset while loading=%s", (loading) => {
  state.loading = loading;
  expect(render()).not.toContain(t("people.filter.reset"));
});

test("the filtered empty state offers exactly one reset", () => {
  state.search = { review: "identity" };
  state.empty = true;
  expect(render().split(t("people.filter.reset"))).toHaveLength(2);
});

test("a unit-filtered empty roster keeps its reset above the stats", () => {
  state.search = { unit: "department" };
  state.empty = true;
  const html = render();
  expect(html.split(t("people.filter.reset"))).toHaveLength(2);
  expect(html.indexOf(t("people.filter.reset"))).toBeLessThan(html.indexOf(`aria-label="${t("people.filter.label")}"`));
});

test.each(VIEWS.filter(view => view.id !== "current"))("the $id view uses the current tab to reset and keeps a reset for extra filters or empty results", (view) => {
  state.search = { status: view.status, review: view.review?.join(","), sort: "hire_date" };
  for (const loading of [false, true]) {
    state.loading = loading;
    expect(render()).not.toContain(t("people.filter.reset"));
  }
  state.search.unit = "department";
  expect(render().split(t("people.filter.reset"))).toHaveLength(2);
  state.search.unit = undefined;
  state.loading = false;
  state.empty = true;
  expect(render().split(t("people.filter.reset"))).toHaveLength(2);
});

test.each([undefined, 21])("a settings outage keeps the roster and reports the failure once with cached window %s", cached => {
  state.staleWindow = cached;
  state.settingsFailed = true;
  state.search = { review: "contractSoon,identity" };
  const html = render();
  expect(html).toContain("roster rows");
  expect(rosterRead).toHaveBeenCalledWith(expect.anything(), undefined, true);
  expect(html.split(t("common.read.failedReason"))).toHaveLength(2);
  expect(html).not.toContain(t("directoryViews.contractSoon", { days: "—" }));
  expect(html).not.toContain(t("roster.review.contractSoon", { days: "—" }));
});

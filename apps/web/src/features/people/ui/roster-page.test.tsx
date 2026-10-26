// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { ApiError, myAccessQuery } from "../../../reference/authz/api";
import { RosterPage } from "./roster-page";

const state = vi.hoisted(() => ({ refused: false, body: "roster rows", org: false }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => vi.fn() }), Link: () => null, useNavigate: () => vi.fn() }));
vi.mock("@tanstack/react-query", async original => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQuery: (options: { queryFn: unknown }) => options.queryFn === myAccessQuery.queryFn ? {
    data: { is_ops: false, entries: state.org ? [{ grant_id: "org", domain: "org", level: "view", enforcement: "ENFORCED", scope: { kind: "TENANT" } }] : [] }, isPending: false, error: null,
  } : ({ data: undefined, isPending: false, isFetching: false, isFetchedAfterMount: true, error: new ApiError(403, "access_denied", ""), refetch: vi.fn() }),
}));
vi.mock("../../../reference/authz/ui/use-can", () => ({ useCan: () => () => false }));
vi.mock("../../../lib/react/prefetch", () => ({ usePrefetch: () => vi.fn() }));
vi.mock("../../../lib/reason-codes", () => ({ useReasonCodesReady: () => false }));
vi.mock("./roster-table", () => ({ RosterTable: () => <div>{state.body}</div> }));
vi.mock("./use-roster", () => ({ BULK_MAX: 100, SOON_DAYS: 60, useRoster: () => ({
  list: { data: state.refused ? undefined : { pages: [{ items: [], total: 1 }] }, isPending: false, error: state.refused ? new ApiError(403, "access_denied", "") : null, refetch: vi.fn() },
  rows: [], total: 1, loading: false, status: { totals: { all: 1 }, failed: [] }, review: { totals: {}, failed: [] }, query: {},
}) }));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => { state.refused = false; state.org = false; });
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

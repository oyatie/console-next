import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, expect, test, vi } from "vitest";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { QueryState } from "./query-state";
import { queryView, readGroup } from "./query-view";

beforeAll(() => loadCatalog("ko"));
const network = vi.hoisted(() => ({ online: true }));
vi.mock("./use-online", () => ({ useOnline: () => network.online }));
afterEach(() => { network.online = true; });

test("a browser offline event marks a successful cached read without waiting for a refetch", async () => {
  network.online = false;
  const html = await markup({ isPending: false, error: null, data: "last good record", refetch: () => {} });
  expect(html).toContain("last good record");
  expect(html).toContain(t("common.read.offline"));
});

test("a missing read shows its catalog reason without a server fallback", async () => {
  const error = new ApiError(404, "scope_not_found", "server fallback", [], undefined, true);
  const html = await markup({ isPending: false, error, data: undefined, refetch: () => {} },
    code => code === "scope_not_found" ? t("attendance.refusal.scope_not_found") : undefined);
  expect(html).toContain(t("attendance.refusal.scope_not_found"));
  expect(html).not.toContain("server fallback");
});

type Read = { isPending: boolean; error: unknown; data: string | undefined; refetch: () => unknown; fetchStatus?: "paused"; isPlaceholderData?: boolean };
async function markup(q: Read, own?: (code: string) => string | undefined, keepOnLoss = false) {
  const root = createRootRoute({ component: () => <QueryState q={q} own={own} keepOnLoss={keepOnLoss}
  >{value => <span>{value}</span>}</QueryState> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
}

test.each([
  [true, undefined, null, "loading"],
  [false, "loaded", null, "ready"],
  [false, undefined, new ApiError(404, "not_found", "missing"), "not-found"],
  [false, "private cached record", new ApiError(403, "forbidden", "denied"), "denied"],
  [false, "removed cached record", new ApiError(404, "not_found", "missing"), "not-found"],
  [false, undefined, new ApiError(503, "service_unavailable", "unavailable"), "failed"],
  [false, undefined, new TypeError("Failed to fetch"), "failed"],
  [false, "last good record", new TypeError("Failed to fetch"), "stale"],
] as const)("the state contract: pending=%s data=%s error=%s → %s", (isPending, data, error, expected) => {
  expect(queryView({ isPending, data, error })).toBe(expected);
});

test("an embedded held read is one announced line without a page layout", async () => {
  const html = await markup({ isPending: true, error: null, data: undefined, refetch: () => {} });
  expect(html).toContain('aria-busy="true"');
  expect(html).toContain('data-bone="line"');
  expect(html.match(/data-bone=/g)).toHaveLength(1);
  expect(html).not.toContain("data-read-layout");
  expect(html).toContain(t("common.loading"));
});

test("a failed read offers retry and its server support reference", async () => {
  const html = await markup({ isPending: false, error: new ApiError(503, "service_unavailable", "unavailable", [], "read-reference"), data: undefined, refetch: () => {} });
  expect(html).toContain(t("common.retry"));
  expect(html).toContain(t("common.operationId"));
  expect(html).toContain("read-reference");
});

test("a paused read keeps last good data visibly marked, with retry", async () => {
  const html = await markup({ isPending: false, fetchStatus: "paused", error: null, data: "last good record", refetch: () => {} });
  expect(html).toContain("last good record");
  expect(html).toContain(t("common.read.offline"));
  expect(html).toContain(t("common.retry"));
});

test("missing records have a distinct state and a way back", async () => {
  const html = await markup({ isPending: false, error: new ApiError(404, "not_found", "missing"), data: undefined, refetch: () => {} });
  expect(html).toContain(t("common.read.notFound.title"));
  expect(html).toContain('href="/"');
  expect(html).not.toContain(t("common.loadFailed.title"));
});

test.each(["forbidden", "out_of_scope", "scope_tenant_wide_only"])("%s shows the shared grant remedy and hides cached records", async code => {
  const html = await markup({ isPending: false, error: new ApiError(403, code, "denied"), data: "private cached record", refetch: () => {} });
  expect(html).toContain(t("common.denied.title.plain"));
  expect(html).toContain(t("common.denied.granters.unavailable"));
  expect(html).not.toContain("private cached record");
});

test("empty data is a successful read, never a refusal inferred from a count", () => {
  expect(queryView({ isPending: false, error: null, data: [] })).toBe("ready");
});

test("a required read's failure wins over a held sibling and retries both", async () => {
  let retries = 0;
  const held = { isPending: true, data: undefined, error: null, refetch: () => retries++ };
  const failed = { isPending: false, data: undefined, error: new ApiError(503, "service_unavailable", "unavailable"), refetch: () => retries++ };
  const grouped = readGroup([held, failed]);
  expect(queryView(grouped)).toBe("failed");
  await grouped.refetch();
  expect(retries).toBe(2);
});

test("a grouped denial takes precedence over a transient failure with cached data", () => {
  const read = { isPending: false, data: "cached", refetch: () => {} };
  expect(queryView(readGroup([
    { ...read, error: new ApiError(503, "service_unavailable", "unavailable") },
    { ...read, error: new ApiError(403, "forbidden", "denied") },
  ]))).toBe("denied");
});

test.each([403, 404])("an opted-in loaded record stays readable after a %s refetch", async status => {
  const html = await markup({ isPending: false, error: new ApiError(status, status === 403 ? "forbidden" : "not_found", "lost"), data: "loaded record", refetch: () => {} }, undefined, true);
  expect(html).toContain("loaded record");
  expect(html).toContain(t(status === 404 ? "live.notice.gone" : "live.notice.no_access"));
  expect(html).toContain('inert=""');
  expect(html).not.toContain(t("common.denied.title.plain"));
});


test("a previous answer is ready and its region stays busy during a changed-key read", async () => {
  const html = await markup({ isPending: false, isPlaceholderData: true, error: null, data: "last good record", refetch: () => {} });
  expect(html).toContain("last good record");
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("data-bone");
});

test("a required read group carries placeholder status to the region", () => {
  const read = { isPending: false, data: "cached", error: null, refetch: () => {}, isPlaceholderData: true };
  const group = readGroup([read]);
  expect(group).toHaveProperty("isPlaceholderData", true);
  expect(queryView(group)).toBe("ready");
});

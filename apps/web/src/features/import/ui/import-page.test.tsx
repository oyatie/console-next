// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { entitiesRef } from "../../../reference/entity/api";
import { rulesQuery } from "../../../reference/identifiers/api";
import { ApiError, excludeReasonsQuery, runQuery, type ImportRun } from "../api";
import { ImportPage } from "./import-page";

vi.mock("../../../reference/authz/ui/access-gate", () => ({ AccessGate: ({ children }: { children: ReactNode }) => children }));
const queries = vi.hoisted(() => ({ reads: new Map<unknown, unknown>() }));
vi.mock("@tanstack/react-query", async original => {
  const actual = await original<typeof import("@tanstack/react-query")>();
  return { ...actual, useQuery: (query: Parameters<typeof actual.useQuery>[0]) => queries.reads.get(query) ?? actual.useQuery(query) };
});
beforeAll(() => loadCatalog("ko"));
const references = [entitiesRef, rulesQuery, excludeReasonsQuery];

const recordedRun: ImportRun = {
  id: "r1", source_filename: "synthetic-roster.xlsx", status: "APPLIED", apply_job_state: "done",
  created_at: "2026-10-01T02:00:00Z", applied_at: "2026-10-01T02:00:00Z", applied_by: { id: "operator", name: "담당테스트" },
  apply_summary: { input_rows: 3, inserted: 3, updated: 0, skipped: 0, companies: [] },
  rolled_back_at: null, rolled_back_by: null, rollback_reason_code: null, rollback_note: null,
  rollback: { job: null, refusal_code: null, mode: "GOVERNED", window_until: null, window_days: 14, pending_request: null }, allowed: [],
};

async function markup(failed?: number, pending = false, cached = false, path = "/people/import", status = 503) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } } });
  await client.prefetchQuery({ ...runQuery(recordedRun.id), queryFn: async () => recordedRun });
  references.forEach((query, i) => {
    queries.reads.set(query, {
      isPending: pending && i === 0,
      data: pending && i === 0 || i === failed && !cached ? undefined : { items: [] },
      error: i === failed ? new ApiError(status, status === 403 ? "forbidden" : "service_unavailable", "unavailable", [], "reference-read") : null,
      refetch: () => undefined,
    });
  });
  const root = createRootRoute({ component: Outlet });
  const app = createRoute({ getParentRoute: () => root, id: "app", component: Outlet });
  const page = createRoute({ getParentRoute: () => app, path: "/people/import", validateSearch: (search: Record<string, unknown>) => search, component: ImportPage });
  const router = createRouter({ routeTree: root.addChildren([app.addChildren([page])]), history: createMemoryHistory({ initialEntries: [path] }) });
  await router.load();
  return renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

test.each([0, 1, 2])("reference %s failure blocks file selection with one retry and reference", async failed => {
  const html = await markup(failed);
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain("reference-read");
  expect(html.match(new RegExp(`>${t("common.retry")}<`, "g"))).toHaveLength(1);
  expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>파일 선택<\/button>/);
  expect(html).not.toContain('type="file"');
  expect(html).not.toContain(t("importRollback.runs.title"));
});

test("pending references show a skeleton and block file selection", async () => {
  const html = await markup(undefined, true);
  expect(html).toContain("data-read-layout");
  expect(html).toContain('aria-disabled="true"');
  expect(html).not.toContain('type="file"');
});

test.each([0, 1, 2])("a failed reference %s refetch retains the loaded upload step", async failed => {
  const html = await markup(failed, false, true);
  expect(html).toContain('type="file"');
  expect(html).toContain(t("common.read.stale"));
  expect(html).not.toMatch(/<button[^>]*aria-disabled="true"[^>]*>파일 선택<\/button>/);
});

test.each([0, 1, 2])("a failed cached reference %s does not replace a completed run report", async failed => {
  const html = await markup(failed, false, true, "/people/import?run=r1");
  expect(html).toContain('id="import-done"');
  expect(html).toContain(recordedRun.source_filename);
  expect(html).toContain(t("import.done.title"));
  expect(html).not.toContain(t("import.reference.required"));
  expect(html).not.toContain(t("common.loadFailed.title"));
});

test("a refused reference gives file selection a permission reason", async () => {
  const html = await markup(0, false, false, "/people/import", 403);
  const description = html.match(/<button[^>]*aria-describedby="([^"]+)"[^>]*>파일 선택<\/button>/)?.[1];
  expect(description).toBeDefined();
  expect(html).toContain(`<span id="${description}">${t("common.denied.reason")}</span>`);
  expect(html).not.toContain(t("import.reference.required"));
});

test("successfully loaded empty references allow upload and recent runs", async () => {
  const html = await markup();
  expect(html).toContain('type="file"');
  expect(html).toContain(t("importRollback.runs.title"));
});

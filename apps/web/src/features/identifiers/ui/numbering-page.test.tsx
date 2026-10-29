// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { ApiError } from "../../../reference/authz/api";
import { loadCatalog, t } from "@console/i18n";
import { checklistRef, entitiesRef } from "../../../reference/entity/api";
import { reasonCodesQuery } from "../../../lib/reason-codes";
import { queryDefaults } from "../../../lib/react/query-defaults";
import { rulesQuery } from "../api";
import { NumberingPage } from "./numbering-page";

vi.mock("../../../reference/authz/ui/access-gate", () => ({ AccessGate: ({ children }: { children: ReactNode }) => children }));
beforeAll(() => loadCatalog("ko"));

async function markup(phase: "SETUP" | "OPERATING" | "loading" | "failed") {
  const client = new QueryClient({ defaultOptions: { queries: { ...queryDefaults, retry: false } } });
  await Promise.all([
    client.fetchQuery({ ...entitiesRef, queryFn: async () => ({ items: [] }) }),
    client.fetchQuery({ ...rulesQuery, queryFn: async () => [] }),
    client.fetchQuery({ ...reasonCodesQuery("employee_number_change"), queryFn: async () => ({ domain: "employee_number_change", items: [] }) }),
  ]);
  if (phase === "failed") {
    await expect(client.fetchQuery({ ...checklistRef, queryFn: () => Promise.reject(new ApiError(500, "internal", "")) })).rejects.toBeInstanceOf(ApiError);
  } else if (phase !== "loading") {
    await client.fetchQuery({ ...checklistRef, queryFn: async () => ({ phase, steps: [], done: 0, total: 0, go_live_at: null,
      summary: { people: 0, placed: 0, unplaced: 0, entity_unknown: 0, progress: 0 },
    }) });
  }
  const root = createRootRoute({ component: NumberingPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  client.clear();
  return html;
}

test("a pending phase uses the shared loading state without claiming go-live or offering a form", async () => {
  const html = await markup("loading");
  expect(html).toContain('data-read-layout="form"');
  expect(html).toContain(t("common.loading"));
  expect(html).not.toContain(t("identifiers.renumber.whyAfter"));
  expect(html).not.toContain(t("identifiers.renumber.preview"));
});

test("a failed phase uses the shared error and retry without offering a form", async () => {
  const html = await markup("failed");
  expect(html).toContain(t("common.loadFailed.title"));
  expect(html).toContain(t("common.retry"));
  expect(html).not.toContain(t("identifiers.renumber.whyAfter"));
  expect(html).not.toContain(t("identifiers.renumber.preview"));
});

test.each(["OPERATING", "SETUP"] as const)("the server's %s phase determines whether the renumber form exists", async phase => {
  const html = await markup(phase);
  expect(html).toContain(t("identifiers.renumber.title"));
  if (phase === "SETUP") {
    expect(html).toContain(t("identifiers.renumber.preview"));
    expect(html).not.toContain(t("identifiers.renumber.whyAfter"));
  } else {
    expect(html).toContain(t("identifiers.renumber.whyAfter"));
    expect(html).not.toContain(t("identifiers.renumber.preview"));
  }
});

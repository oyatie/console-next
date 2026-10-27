// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// oxlint-disable-next-line no-restricted-imports -- Render tests supply the shared read boundary's router.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
// oxlint-disable-next-line no-restricted-imports -- Refusal rendering needs an isolated, disabled query client.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// oxlint-disable-next-line no-restricted-imports -- Synthetic transport failures exercise the shared read boundary.
import { ApiError } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { Page } from "./page";
import { PageMain } from "./page-main";
import { Crumbs } from "../page-head/crumbs";

beforeAll(() => loadCatalog("ko"));
const q = { isPending: false, error: null as unknown, data: ["Visible record"] as string[] | undefined, refetch() {} };
const copy = { home: "Home", body: "Body", fields: "Fields", register: "Register", empty: "No records" };
async function markup(children: ReactNode) {
  const route = createRootRoute({ component: () => children });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}

test.each([false, true])("one main and one h1, standalone or in the shell: %s", async shell => {
  const frame = <Page floorplan="list" head={{ title: "Employees", titleId: "title", crumbs: <Crumbs items={[<a key="home" href="/">{copy.home}</a>]} /> }}><p>{copy.body}</p></Page>;
  const html = await markup(shell ? <PageMain>{frame}</PageMain> : frame);
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html.match(/<nav\b/g)).toHaveLength(1);
  expect(html).toContain('data-floorplan="list"');
  expect(html).toContain('id="title"');
});

test("an embedded page keeps its title below the document heading", async () => {
  const html = await markup(<Page floorplan="record" head={{ title: "Record" }}>
    <Page floorplan="form" head={{ title: "Correction" }}>{copy.fields}</Page>
  </Page>);
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toMatch(/<h2\b[^>]*>Correction<\/h2>/);
});

test.each(["loading", "empty", "failed", "refused", "populated"])("the %s read retains the frame and uses one shared read boundary", async state => {
  const error = state === "failed" ? new ApiError(503, "service_unavailable", "", [], "read-reference")
    : state === "refused" ? new ApiError(403, "access_denied", "", [], "refusal-reference") : null;
  const read = { ...q, isPending: state === "loading", error, data: state === "loading" || state === "failed" ? undefined : state === "empty" ? [] : q.data };
  const html = await markup(<Page floorplan="list" head={{ title: "Employees", primary: <button>{copy.register}</button> }} q={read}
    empty={rows => rows.length ? null : <p>{copy.empty}</p>}>
    {rows => <p>{rows.join(", ")}</p>}
  </Page>);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain("Employees");
  if (state === "loading") expect(html).toContain("data-bone");
  if (state === "empty") expect(html).toContain("No records");
  if (state === "populated") expect(html).toContain("Visible record");
  if (state === "failed") {
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toContain("read-reference");
    expect(html.split(t("common.retry"))).toHaveLength(2);
  }
  if (state === "refused") {
    expect(html).toContain("refusal-reference");
    expect(html).not.toContain("Visible record");
    expect(html).not.toContain("Register");
  }
});

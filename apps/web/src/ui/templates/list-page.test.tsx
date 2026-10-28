// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
// oxlint-disable-next-line no-restricted-imports -- Isolated shared read-boundary render.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// oxlint-disable-next-line no-restricted-imports -- The read boundary retains its router context.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
// oxlint-disable-next-line no-restricted-imports -- Synthetic refusals test the existing frame boundary.
import { ApiError } from "@console/api";
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { ListPage } from "./list-page";

beforeAll(() => loadCatalog("ko"));
const copy = { filters: "Filters", toolbar: "Toolbar", row: "Visible record", sheet: "Side sheet", empty: "No records" };
test.each(["populated", "loading", "empty", "failed", "stale", "refused"])("the List template delegates %s to the page boundary", async state => {
  const q = { isPending: state === "loading", data: state === "failed" || state === "loading" ? undefined : state === "empty" ? [] : [copy.row], refetch() {},
    error: state === "refused" ? new ApiError(403, "access_denied", "", [], "list-refusal") : state === "failed" || state === "stale" ? new ApiError(503, "service_unavailable", "", [], "list-failure") : null };
  const route = createRootRoute({ component: () => <ListPage head={{title:"Employees"}} q={q}
    filters={<button>{copy.filters}</button>} toolbar={<button>{copy.toolbar}</button>} sheet={<aside>{copy.sheet}</aside>}
    empty={rows => rows.length ? null : <p>{copy.empty}</p>}>
    {rows => rows.map(row => <p key={row}>{row}</p>)}
  </ListPage> });
  const router = createRouter({routeTree: route, history: createMemoryHistory({initialEntries:["/"]})});
  await router.load();
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><RouterProvider router={router} /></QueryClientProvider>);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html).toContain('data-floorplan="list"');
  for (const text of [copy.filters, copy.toolbar, copy.sheet]) {
    if (state === "refused") expect(html).not.toContain(text);
    else expect(html).toContain(text);
  }
  if (state === "populated" || state === "stale") expect(html).toContain(copy.row);
  else expect(html).not.toContain(copy.row);
  if (state === "empty") expect(html).toContain(copy.empty);
  if (state === "failed" || state === "stale") expect(html).toContain("list-failure");
  if (state === "refused") expect(html).toContain("list-refusal");
});

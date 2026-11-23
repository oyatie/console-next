// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
// oxlint-disable-next-line no-restricted-imports -- The shared read boundary needs a router in render tests.
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
// oxlint-disable-next-line no-restricted-imports -- Refusal tests disable the boundary's supporting queries.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// oxlint-disable-next-line no-restricted-imports -- Exercise the existing read boundary with a transport refusal.
import { ApiError } from "@console/api";
import { loadCatalog } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import type { ReadState } from "../../lib/react/query-view";
import { PageMain } from "../page/page-main";
import { Worklist } from "./worklist";
import { worklistOptionalRegions } from "./worklist-contract";

beforeAll(() => loadCatalog("ko"));

const actionLinkLabel = "Action link";
const readyRead: ReadState = { isPending: false, error: null, data: true, refetch() {} };
const mark = (name: string) => <bdi data-contract-region={name}>{name}</bdi>;

async function markup(children: ReactNode) {
  const route = createRootRoute({ component: () => children });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const screen = (q: ReadState = readyRead) => (
  <Worklist
    q={q}
    head={{
      title: mark("head"),
      titleId: "worklist-title",
      asOf: mark("asOf"),
      actions: <a href="/inbox">{actionLinkLabel}</a>,
      primary: { id: "new", label: "New item", onAction() {} },
      commands: { label: "Commands", items: [{ id: "columns", label: "Columns", onAction() {} }] },
    }}
    tabs={
      <nav aria-label="Views">
        <a href="/inbox" aria-current="page">
          {mark("tabs")}
        </a>
      </nav>
    }
    views={<button type="button" aria-pressed="true">{mark("views")}</button>}
    find={mark("find")}
    filters={mark("filters")}
    tools={mark("tools")}
    stats={mark("stats")}
    notes={mark("notes")}
    list={
      <div role="grid" aria-label="Worklist">
        <div role="row">
          <div role="gridcell">{mark("list")}</div>
        </div>
      </div>
    }
    schedule={mark("schedule")}
    bands={mark("bands")}
    record={{ id: "item-1", label: "Selected item", onClose() {}, children: mark("record") }}
    related={{ id: "rel-1", label: "Related record", onClose() {}, children: mark("related") }}
    foot={mark("foot")}
    facts={mark("facts")}
    overlays={mark("overlays")}
  />
);

test.each([false, true])("Worklist places every supplied region once with one main and h1 (shell: %s)", async shell => {
  expect(worklistOptionalRegions).toEqual(["facts"]);
  const html = await markup(shell ? <PageMain>{screen()}</PageMain> : screen());
  for (const name of [
    "head",
    "asOf",
    "tabs",
    "views",
    "find",
    "filters",
    "tools",
    "stats",
    "notes",
    "list",
    "schedule",
    "bands",
    "record",
    "related",
    "foot",
    "overlays",
  ]) {
    expect(html.split(`data-contract-region="${name}"`), name).toHaveLength(2);
  }
  expect(html).not.toContain('data-contract-region="facts"');
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('data-pattern="worklist"');
  expect(html).toContain('data-detail="true"');
  expect(html).toContain('id="worklist-title"');
  expect(html.match(/<aside\b/g)).toHaveLength(2);
});

test("Worklist strips every data region and command on 403 refusal while keeping h1 and tabs", async () => {
  const html = await markup(screen({ ...readyRead, error: new ApiError(403, "access_denied", "", [], "refused-worklist") }));
  expect(html).toContain('data-contract-region="head"');
  expect(html).toContain('data-contract-region="tabs"');
  expect(html).toContain("refused-worklist");
  expect(html).not.toContain("data-detail");
  for (const name of [
    "asOf",
    "views",
    "find",
    "filters",
    "tools",
    "stats",
    "notes",
    "list",
    "schedule",
    "bands",
    "record",
    "related",
    "foot",
    "facts",
    "overlays",
  ]) {
    expect(html).not.toContain(`data-contract-region="${name}"`);
  }
  for (const label of ["New item", "Columns", actionLinkLabel]) expect(html).not.toContain(label);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
});

test.each(["loading", "failed"])("Worklist %s keeps commands and overlays mounted while withholding list data", async state => {
  const html = await markup(
    screen({
      ...readyRead,
      isPending: state === "loading",
      data: undefined,
      error: state === "failed" ? new ApiError(503, "service_unavailable", "", [], "worklist-failure") : null,
    }),
  );
  expect(html).toContain('data-contract-region="tabs"');
  expect(html).toContain('data-contract-region="overlays"');
  expect(html).toContain(">New item</button>");
  expect(html).not.toContain('data-contract-region="list"');
  expect(html).not.toContain('data-contract-region="stats"');
  expect(html).not.toContain('data-contract-region="schedule"');
  if (state === "failed") expect(html).toContain("worklist-failure");
});

test("Worklist omits data-detail on 404 not-found even when cached data and record pane are supplied", async () => {
  const html = await markup(screen({ ...readyRead, error: new ApiError(404, "not_found", "", [], "missing-worklist") }));
  expect(html).not.toContain("data-detail");
  expect(html).toContain('data-contract-region="head"');
  expect(html.match(/<h1\b/g)).toHaveLength(1);
});

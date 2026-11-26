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
import { beforeAll, expect, test, vi } from "vitest";
import type { ReadState } from "../../lib/react/query-view";
import { ListRecord } from "./list-record";
import { listRecordOptionalRegions } from "./list-record-contract";
import { PageMain } from "../page/page-main";

const style = vi.hoisted(() => ({ id: "baseline" as "baseline" | "console" }));
vi.mock("../../experience/dom", async original => ({ ...(await original<typeof import("../../experience/dom")>()), useActiveExperienceId: () => style.id }));

beforeAll(() => loadCatalog("ko"));
const registerLink = "Register link";
const read = { isPending: false, error: null as unknown, data: true, refetch() {} };
const mark = (name: string) => <span data-contract-region={name}>{name}</span>;
async function markup(children: ReactNode) {
  const route = createRootRoute({ component: () => children });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
}
const screen = (q: ReadState = read) => <ListRecord q={q}
  head={{ title: mark("head"), titleId: "roster-title", asOf: mark("asOf"), actions: <a href="/people/new">{registerLink}</a>, primary: { id: "register", label: "Register", onAction() {} }, commands: { label: "Commands", items: [{ id: "import", label: "Import", onAction() {} }] } }}
  tabs={<nav aria-label="Routes"><a href="/people" aria-current="page">{mark("tabs")}</a></nav>}
  views={<button aria-pressed="true">{mark("views")}</button>}
  find={mark("find")} filters={mark("filters")} tools={mark("tools")} notes={mark("notes")}
  list={<div role="grid" aria-label="Roster"><div role="row"><div role="gridcell">{mark("list")}</div></div></div>}
  record={{ id: "person", label: "Person record", onClose() {}, children: mark("record") }}
  related={{ id: "unit", label: "Related unit", onClose() {}, children: mark("related") }}
  foot={mark("foot")} facts={mark("facts")} overlays={mark("overlays")}
/>;

test.each([false, true])("baseline places every supplied region once with one main and h1 (shell: %s)", async shell => {
  expect(listRecordOptionalRegions).toEqual(["facts"]);
  const html = await markup(shell ? <PageMain>{screen()}</PageMain> : screen());
  for (const name of ["head", "asOf", "list", "tabs", "views", "find", "filters", "tools", "notes", "record", "related", "foot", "overlays"]) {
    expect(html.split(`data-contract-region="${name}"`), name).toHaveLength(2);
  }
  expect(html).not.toContain('data-contract-region="facts"');
  expect(html.match(/<main\b/g)).toHaveLength(1);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
  expect(html).toContain('id="roster-title"');
  expect(html).toContain('role="grid" aria-label="Roster"');
  expect(html.match(/<aside\b/g)).toHaveLength(2);
  expect(html).toMatch(/<aside[^>]*aria-label="Person record"/);
  expect(html).toMatch(/<aside[^>]*aria-label="Related unit"/);
  expect(html).not.toContain('role="tablist"');
  expect(html).toMatch(/data-edge="bottom"[^>]*><header/);
  expect(html).toContain('aria-pressed="true"');
  expect(html).toContain('href="/people" aria-current="page"');
  expect(html).toContain('<a href="/people/new">Register link</a>');
  for (const label of ["Register", "Import"]) expect(html).toContain(`>${label}</button>`);
});

test("optional regions may be absent without replacing the list", async () => {
  const html = await markup(<ListRecord q={read} head={{ title: "Roster" }} list={mark("list")} />);
  expect(html).toContain('data-contract-region="list"');
  expect(html).not.toContain("<aside");
  expect(html).not.toContain('data-tabs="true"');
  expect(html.match(/<h1\b/g)).toHaveLength(1);
});

test("a refusal removes every data region and command, including retained data", async () => {
  const html = await markup(screen({ ...read, error: new ApiError(403, "access_denied", "", [], "refused-read") }));
  expect(html).toContain('data-contract-region="head"');
  expect(html).toContain("refused-read");
  expect(html).toContain('data-contract-region="tabs"');
  for (const name of ["asOf", "list", "views", "find", "filters", "tools", "notes", "record", "related", "foot", "facts", "overlays"]) expect(html).not.toContain(`data-contract-region="${name}"`);
  for (const label of ["Register", "Import", "Register link"]) expect(html).not.toContain(label);
  expect(html.match(/<h1\b/g)).toHaveLength(1);
});

test.each(["loading", "failed"])("%s keeps commands and their overlays mounted", async state => {
  const html = await markup(screen({ ...read, isPending: state === "loading", data: undefined, error: state === "failed" ? new ApiError(503, "service_unavailable", "", [], "pattern-failure") : null }));
  expect(html).toContain('data-contract-region="tabs"');
  expect(html).toContain('data-contract-region="overlays"');
  expect(html).toContain('>Register</button>');
  expect(html).not.toContain('data-contract-region="list"');
  if (state === "failed") expect(html).toContain("pattern-failure");
});

const BASELINE_FALLBACK = "baseline-fallback";

test("ListRecord renders baseline fallback when baseline prop is supplied in baseline experience", async () => {
  const html = await markup(
    <ListRecord
      q={read}
      head={{ title: "Roster" }}
      list={mark("list")}
      baseline={() => <div data-baseline-fallback="true">{BASELINE_FALLBACK}</div>}
    />,
  );
  expect(html).toContain('data-baseline-fallback="true"');
  expect(html).not.toContain('data-contract-region="list"');
});

const failure = { ...read, data: undefined, error: new ApiError(503, "service_unavailable", "", [], "pattern-failure") };
const why = "Load the roster to register.";
const register = "Register";
const ownPrimary = (q: ReadState) => <ListRecord q={q} list={mark("list")} failedActions={<span id="why">{why}</span>}
  head={{ title: "Roster", primary: <button type="button" aria-disabled="true" aria-describedby="why">{register}</button> }} />;

test.each(["baseline", "console"] as const)("%s: a screen's own primary takes the primary slot and its failure actions sit in the list failure's alert", async id => {
  style.id = id;
  try {
    const failed = await markup(ownPrimary(failure));
    expect(failed).toContain('<button type="button" aria-disabled="true" aria-describedby="why">Register</button>');
    expect(failed.split("Load the roster to register.")).toHaveLength(2);
    expect(failed.slice(failed.indexOf('role="alert"'))).toContain('<span id="why">Load the roster to register.</span>');
    const ready = await markup(ownPrimary(read));
    expect(ready).toContain(">Register</button>");
    expect(ready).not.toContain("Load the roster to register.");
  } finally { style.id = "baseline"; }
});

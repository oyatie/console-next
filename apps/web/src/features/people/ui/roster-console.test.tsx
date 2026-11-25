// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { ListRecordProps } from "../../../ui/patterns/list-record-contract";
import { NO_SELECTION } from "../../../ui/long-table/selection";
import { RosterConsole } from "./roster-console";
import type { useRosterScreen } from "./use-roster-screen";

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useNavigate: () => () => {},
  useLocation: () => undefined,
  useRouter: () => ({ subscribe: () => () => {} }),
  useElementScrollRestoration: () => undefined,
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

// Only the head's slots: the list's own read state never gates what is drawn here (the page's read failure is told once,
// while the head keeps its controls and their reads).
vi.mock("../../../ui/patterns/list-record", () => ({
  ListRecord: ({ head, find, tools, list }: ListRecordProps) => <><header>{head.actions}{find}{tools}</header><section>{list}</section></>,
}));
vi.mock("./roster-table", () => ({ RosterTable: () => <div role="grid" /> }));
// Restoration runs in effects; the marker shows which grid it is bound to.
vi.mock("./table-scroll-restoration", () => ({ TableScrollRestoration: ({ id }: { id: string }) => <i data-restores={id} /> }));

beforeAll(() => loadCatalog("ko"));

const noop = () => {};
function screen(listFailed: boolean) {
  const list = { data: listFailed ? undefined : { pages: [{ offset: 0 }] }, error: listFailed ? new Error("unavailable") : null, isError: listFailed,
    hasNextPage: false, isFetchingNextPage: false, fetchNextPage: noop, refetch: noop };
  return {
    contractWindow: { isError: false }, soonDays: 30, search: {}, navigate: noop, today: "2026-10-26", status: "current", review: [], unit: undefined,
    ids: [], open: undefined, openUnit: undefined, select: noop, selectRelated: noop, full: false, expand: noop, restore: noop, unitTrigger: { current: null },
    unitItems: [], selectedUnit: undefined, sort: "name", q: "", exitView: "kept", setExitView: noop, sel: NO_SELECTION, setSel: noop, recorded: undefined,
    batch: null, setBatch: noop, rescinding: false, setRescinding: noop, setRecorded: noop, rescindReady: false,
    r: { total: listFailed ? undefined : 0, loading: false, list, rows: [], status: { totals: { all: 3 } }, review: { totals: {} }, facets: undefined, changed: false, query: {} },
    view: { shown: [], set: noop }, prefetch: noop, setFilter: noop, find: noop, reset: noop, closePaste: noop, bulkDone: noop, openRecord: noop,
    scroller: { current: null }, scrollRef: noop, onRowFocus: noop, filtered: false, customFilters: false, sameName: 0, onRowAction: noop,
  } as unknown as ReturnType<typeof useRosterScreen>;
}

const render = (listFailed: boolean) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}><RosterConsole manage screen={screen(listFailed)} /></QueryClientProvider>,
);

// Saved views are the same control in both styles: one button in the roster's head, kept in place while its read is
// pending and while the roster's own read has failed.
test.each([false, true])("the roster head offers saved views (roster read failed: %s)", listFailed => {
  const html = render(listFailed);
  const views = html.match(new RegExp(`<button[^>]*>${t("directoryViews.open")}</button>`, "g")) ?? [];
  expect(views).toHaveLength(1);
  expect(views[0]).toContain("disabled");
});

// The grid's rows render after the router restores scroll, so Back from a record must put the roster's own scroll back once they have.
test("the roster grid reapplies its scroll position on Back", () => {
  expect(render(false)).toContain('data-restores="people-roster"');
});

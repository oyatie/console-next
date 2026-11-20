// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { readIdentity } from "../../../lib/query";
import { Button } from "../../../ui/button/button";
import { commitLabel } from "../../../ui/composer/actions";
import { Home } from "../Home";
import type { AttentionInboxItem, AttentionInboxResponse } from "../domain/inbox-filter";
import { ALL_OPTIONAL_WORKLIST_COLUMNS, isInlineApprovalDecidable } from "../domain/inline-decide";
import { InboxPage } from "./inbox-page";
import { WorklistLower } from "./worklist-lower";
import { WorklistSchedule } from "./worklist-schedule";
import { ConsoleWorklistTable } from "./worklist-table";

const edgeState = vi.hoisted(() => ({
  mePhase: "OPERATING" as "OPERATING" | "SETUP",
  meFetched: true,
  meError: false,
  facetsError: false,
  access: { is_ops: false, entries: [] as unknown[] },
  inboxPages: [] as AttentionInboxResponse[],
}));

vi.mock("../../../experience/dom", async original => ({
  ...(await original<typeof import("../../../experience/dom")>()),
  useActiveExperienceId: () => "console" as const,
}));

function buildQueryReply(path: string, enabled?: boolean) {
  if (enabled === false) {
    return { data: undefined, isPending: true, isFetching: false, isError: false, isSuccess: false, isFetchedAfterMount: false };
  }
  const byPath: Record<string, unknown> = {
    "/api/v1/users/me": {
      data: edgeState.meError
        ? undefined
        : { display_name: "EdgeTester", tenant: { name: "EdgeCorp", phase: edgeState.mePhase, go_live_at: null } },
      isError: edgeState.meError,
      error: edgeState.meError ? new Error("me failed") : null,
      isSuccess: !edgeState.meError,
      isFetchedAfterMount: edgeState.meFetched,
      dataUpdatedAt: 1,
    },
    "/api/v1/access/me": { data: edgeState.access, isFetchedAfterMount: true },
    "/api/v1/employees/facets": {
      data: undefined,
      isError: edgeState.facetsError,
      error: edgeState.facetsError ? new Error("facets failed") : null,
      isSuccess: false,
    },
  };
  return {
    data: { items: [] },
    isPending: false,
    isFetching: false,
    isError: false,
    isSuccess: true,
    isFetchedAfterMount: true,
    ...(byPath[path] as object | undefined),
  };
}

vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) =>
    buildQueryReply(String(JSON.parse(readIdentity(options))[0]), options.enabled),
  useInfiniteQuery: (options: Parameters<typeof readIdentity>[0]) => {
    const parsed = JSON.parse(readIdentity(options)) as [string, { query?: { filter?: string } }?];
    const isQueue = parsed[0] === "/api/v1/me/action-inbox" && parsed[1]?.query?.filter !== "notices";
    return {
      data: { pages: isQueue ? edgeState.inboxPages : [{ items: [], next_cursor: null }] },
      isPending: false,
      isFetching: false,
      isError: false,
      isSuccess: true,
      isPlaceholderData: false,
      dataUpdatedAt: 1,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    };
  },
}));

const makeItem = (extra: Partial<AttentionInboxItem> = {}): AttentionInboxItem => ({
  id: "edge-org-1",
  kind: "org_change_approve",
  lane: "turn",
  title: "Edge Reorg",
  ref: "OC-2026-0418",
  urg: "today",
  due: "2026-11-12T00:00:00+09:00",
  dueTone: "warn",
  done: false,
  days_remaining: 2,
  can_decide: true,
  links: [{ kind: "org_change", id: "00000000-0000-4000-8000-000000000418" }],
  context: { command: "approve", drafter: "Kim", reason: "Turn" },
  ...extra,
});

const makePage = (items: AttentionInboxItem[]): AttentionInboxResponse => ({
  items,
  total: items.length,
  total_is_exact: true,
  next_cursor: null,
  unavailable: [],
  available_filters: ["turn", "waiting"],
  attention_filters: [{ key: "all", total: items.length, total_is_exact: true }],
  counts: { turn: { total: items.length, total_is_exact: true } },
  upcoming: [],
  has_work: items.length > 0,
  quick_starts: [],
  as_of: "2026-11-10T09:00:00+09:00",
});

const renderEdge = (url: string, node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterContextProvider
        router={createRouter({
          routeTree: createRootRoute(),
          history: createMemoryHistory({ initialEntries: [url] }),
        })}
      >
        {node}
      </RouterContextProvider>
    </QueryClientProvider>,
  );

beforeAll(() => loadCatalog("ko"));

beforeEach(() => {
  edgeState.mePhase = "OPERATING";
  edgeState.meFetched = true;
  edgeState.meError = false;
  edgeState.facetsError = false;
  edgeState.access = { is_ops: false, entries: [] };
  edgeState.inboxPages = [makePage([makeItem()])];
});

test("non-decider org_change_approve suppresses row command fallback while preserving review link", () => {
  edgeState.inboxPages = [makePage([makeItem({ can_decide: false })])];
  const approveText = commitLabel({ kind: "orgChange", mode: "approve" });
  const markup = renderEdge(
    "/",
    <Home
      action={() => <Button size="sm">{approveText}</Button>}
      inlineRowAction={item => (isInlineApprovalDecidable(item) ? <Button size="sm">{t("uiWorklist.approve")}</Button> : null)}
      canOrgStructure={false}
    />,
  );
  expect(markup).not.toContain(approveText);
  expect(markup).toContain(t("home.decide.review"));
});

test("Home flattens multi-page responses and WorklistSchedule never moves dated items to undatedCol", () => {
  edgeState.inboxPages = [makePage([makeItem()]), makePage([makeItem({ id: "page2-item", title: "Page2WorkItem" })])];
  expect(renderEdge("/", <Home canOrgStructure={false} />)).toContain("Page2WorkItem");

  const strip = renderEdge(
    "/",
    <WorklistSchedule
      items={[
        makeItem({ id: "old-35", due: "2026-10-06T09:00:00+09:00", days_remaining: -35 }),
        makeItem({ id: "today-1", due: "2026-11-10T09:00:00+09:00", days_remaining: 0 }),
      ]}
      asOf="2026-11-10T09:00:00+09:00"
    />,
  );
  expect(strip).toContain(t("uiWorklist.today"));
  expect(strip.match(/<td class="[^"]*undatedCol[^"]*"><\/td>/g)).toHaveLength(2);
});

test("Console /inbox gates queue UI during SETUP meRead refetch and WorklistLower shows facets error", () => {
  edgeState.mePhase = "SETUP";
  edgeState.meFetched = false;
  const setupHtml = renderEdge("/inbox", <InboxPage canOrgStructure={false} />);
  expect(setupHtml).not.toContain(t("home.inbox.tab.waiting"));
  expect(setupHtml).not.toContain("OC-2026-0418");

  edgeState.access = {
    is_ops: false,
    entries: [{ domain: "hr_basic", level: "view", enforcement: "ENFORCED", scope: { kind: "TENANT", include_descendants: true }, grant_id: "g-1", role_id: "r-1", role_name_ko: "HR", valid_from: "2026-01-01T00:00:00Z", caveats: [] }],
  };
  edgeState.facetsError = true;
  const lowerHtml = renderEdge("/", <WorklistLower items={[]} canOrgStructure={false} />);
  expect(lowerHtml.split(t("home.worklist.headcount"))[1] ?? "").toContain(t("common.loadFailed.title"));
});

test("ConsoleWorklistTable collapsed folds use fold: rowId and consistent selectAll", () => {
  const foldA = makeItem({ id: "fold-1", kind: "register_review", fold_key: "f1" });
  const foldB = makeItem({ id: "fold-2", kind: "register_review", fold_key: "f1" });
  const tableHtml = renderEdge(
    "/",
    <ConsoleWorklistTable
      items={[foldA, foldB]}
      checkedIds={new Set(["fold-1"])}
      onToggleCheck={vi.fn()}
      onToggleAll={vi.fn()}
      shownCols={new Set(ALL_OPTIONAL_WORKLIST_COLUMNS)}
    />,
  );
  expect(tableHtml).toContain('data-id="fold:fold-1"');
  expect(tableHtml).not.toMatch(new RegExp(`aria-label="${t("home.worklist.selectAll")}"[^>]*checked=""`));
});

test("Console /inbox non-queue tabs gate InboxTabs and asOf during meRead pending, error, and SETUP", () => {
  edgeState.mePhase = "SETUP";
  edgeState.meFetched = false;
  const pendingDoneHtml = renderEdge("/inbox?tab=done", <InboxPage canOrgStructure={false} />);
  expect(pendingDoneHtml).not.toContain(t("home.inbox.tab.waiting"));
  expect(pendingDoneHtml).not.toContain("<time");

  edgeState.meFetched = true;
  const settledSetupHtml = renderEdge("/inbox?tab=reference", <InboxPage canOrgStructure={false} />);
  expect(settledSetupHtml).not.toContain(t("home.inbox.tab.waiting"));
  expect(settledSetupHtml).not.toContain("<time");

  edgeState.mePhase = "OPERATING";
  edgeState.meError = true;
  const errorSnoozedHtml = renderEdge("/inbox?tab=snoozed", <InboxPage canOrgStructure={false} />);
  expect(errorSnoozedHtml).not.toContain(t("home.inbox.tab.waiting"));
  expect(errorSnoozedHtml).not.toContain("<time");
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { readIdentity } from "../../../lib/query";
import { Home } from "../Home";
import type { AttentionInboxResponse } from "../domain/inbox-filter";
import { InboxPage } from "./inbox-page";

type OrgDetail = components["schemas"]["OrgChangeDetail"];
type Facets = components["schemas"]["EmployeeFacets"];
type OrgStructure = components["schemas"]["OrgStructure"];

const state = vi.hoisted(() => ({
  experience: "console" as "baseline" | "console",
  access: { is_ops: false, entries: [] as unknown[] },
  mePhase: "OPERATING" as "OPERATING" | "SETUP",
  meFetched: true,
  facets: undefined as Facets | undefined,
  facetsError: false,
  structure: undefined as OrgStructure | undefined,
  orgUnits: [] as { id: string; name: string; headcount: number }[],
  orgDetail: undefined as OrgDetail | undefined,
  reads: [] as string[],
  inboxPages: [] as AttentionInboxResponse[],
  hasNextPage: false,
}));

vi.mock("../../../experience/dom", async original => ({
  ...(await original<typeof import("../../../experience/dom")>()),
  useActiveExperienceId: () => state.experience,
}));

vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) => {
    const path = String(JSON.parse(readIdentity(options))[0]);
    if (options.enabled === false) {
      return { data: undefined, isPending: true, isFetching: false, isError: false, isSuccess: false, isFetchedAfterMount: false };
    }
    state.reads.push(path);
    if (path === "/api/v1/users/me") {
      return {
        data: { display_name: "Tester", tenant: { name: "Corp", phase: state.mePhase, go_live_at: "2026-01-01T00:00:00Z" } },
        isPending: false,
        isFetching: false,
        isError: false,
        isSuccess: true,
        isFetchedAfterMount: state.meFetched,
        dataUpdatedAt: 1,
      };
    }
    if (path === "/api/v1/access/me") {
      return {
        data: state.access,
        isPending: false,
        isFetching: false,
        isError: false,
        isSuccess: true,
        isFetchedAfterMount: true,
      };
    }
    if (path === "/api/v1/employees/facets") {
      return {
        data: state.facetsError ? undefined : state.facets,
        isPending: false,
        isFetching: false,
        isError: state.facetsError,
        error: state.facetsError ? new Error("facets failed") : null,
        isSuccess: !state.facetsError && Boolean(state.facets),
      };
    }
    if (path === "/api/v1/org-structure") {
      return {
        data: state.structure,
        isPending: false,
        isFetching: false,
        isError: false,
        isSuccess: Boolean(state.structure),
      };
    }
    if (path === "/api/v1/org-units") {
      return {
        data: { items: state.orgUnits },
        isPending: false,
        isFetching: false,
        isError: false,
        isSuccess: true,
      };
    }
    if (path === "/api/v1/org-changes/{id}") {
      return {
        data: state.orgDetail,
        isPending: false,
        isFetching: false,
        isError: false,
        isFetchedAfterMount: true,
        isSuccess: Boolean(state.orgDetail),
      };
    }
    return { data: { items: [] }, isPending: false, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true };
  },
  useInfiniteQuery: () => ({
    data: { pages: state.inboxPages },
    isPending: false,
    isFetching: false,
    isError: false,
    isSuccess: true,
    isPlaceholderData: false,
    dataUpdatedAt: 1,
    hasNextPage: state.hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  }),
}));

function samplePage(): AttentionInboxResponse {
  return {
    items: [
      {
        id: "org-1",
        kind: "org_change_approve",
        lane: "turn",
        title: "Merge Team B",
        ref: "OC-2026-0418",
        urg: "today",
        due: "2026-11-12T00:00:00+09:00",
        dueTone: "warn",
        done: false,
        days_remaining: 2,
        can_decide: true,
        links: [{ kind: "org_change", id: "00000000-0000-4000-8000-000000000418" }],
        context: { command: "approve", drafter: "Kim", reason: "My approval turn" },
      },
      {
        id: "stat-1",
        kind: "insurance_filing",
        lane: "turn",
        title: "Insurance filing",
        ref: "INS-1",
        urg: "wait",
        due: "2026-11-17T00:00:00+09:00",
        due_basis: "statutory",
        dueTone: "neutral",
        done: false,
        days_remaining: 7,
        links: [{ kind: "statutory", id: "ins-1" }],
      },
    ],
    total: 12,
    total_is_exact: true,
    next_cursor: null,
    unavailable: [],
    available_filters: ["turn", "waiting"],
    attention_filters: [
      { key: "all", total: 12, total_is_exact: true },
      { key: "approvals", total: 2, total_is_exact: true },
      { key: "today", total: 1, total_is_exact: true },
      { key: "overdue", total: 0, total_is_exact: true },
    ],
    counts: { turn: { total: 12, total_is_exact: true }, waiting: { total: 1, total_is_exact: true } },
    upcoming: [],
    has_work: true,
    quick_starts: [],
    as_of: "2026-11-10T09:00:00+09:00",
  };
}

function renderNode(url: string, node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createRouter({
    routeTree: createRootRoute(),
    history: createMemoryHistory({ initialEntries: [url] }),
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <RouterContextProvider router={router}>{node}</RouterContextProvider>
    </QueryClientProvider>,
  );
}

beforeAll(() => loadCatalog("ko"));

beforeEach(() => {
  state.experience = "console";
  state.access = { is_ops: false, entries: [] };
  state.mePhase = "OPERATING";
  state.meFetched = true;
  state.facets = undefined;
  state.facetsError = false;
  state.structure = undefined;
  state.orgUnits = [];
  state.orgDetail = undefined;
  state.reads = [];
  state.inboxPages = [samplePage()];
  state.hasNextPage = false;
});

const inboxLink = () => `href="/inbox">${t("home.inbox.viewInbox")}</a>`;
const home = () => renderNode("/", <Home canOrgStructure={false} />);
const rows = (count: number) => Array.from({ length: count }, (_, i) => ({ ...samplePage().items[1]!, id: `stat-${i}` }));

test("Console home links to the full to-do list once every item is on the page, even with its own lane empty", () => {
  state.inboxPages = [{ ...samplePage(), total: 2 }];
  expect(home()).toContain(inboxLink());
  state.inboxPages = [{ ...samplePage(), items: [], total: 0, attention_filters: [] }];
  expect(home()).toContain(inboxLink());
});

test("Console home links to the full to-do list beside the more bar when the list is long or on later pages", () => {
  state.inboxPages = [{ ...samplePage(), items: rows(31), total: 31 }];
  expect(home()).toContain(inboxLink());
  state.inboxPages = [{ ...samplePage(), total: 15, total_is_exact: false }];
  state.hasNextPage = true;
  expect(home()).toContain(inboxLink());
});

test("Console home links to the full to-do list beside the more bar while a short remainder is loaded", () => {
  state.inboxPages = [{ ...samplePage(), items: rows(23), total: 23 }];
  expect(home()).toContain(t("home.worklist.moreCount", { count: 13 }));
  expect(home()).toContain(inboxLink());
});

test("Console offers no to-do link when no lane holds anything, nor on /inbox itself", () => {
  state.inboxPages = [{ ...samplePage(), items: [], total: 0, has_work: false, available_filters: [], attention_filters: [] }];
  expect(home()).not.toContain(t("home.inbox.viewInbox"));
  state.inboxPages = [{ ...samplePage(), total: 2 }];
  expect(renderNode("/inbox", <InboxPage canOrgStructure={false} />)).not.toContain(t("home.inbox.viewInbox"));
});

test("baseline experience keeps Home on Classic fallback without firing Console lower reads", () => {
  state.experience = "baseline";
  state.access = {
    is_ops: false,
    entries: [
      {
        domain: "hr_basic",
        level: "view",
        enforcement: "ENFORCED",
        scope: { kind: "TENANT", include_descendants: true },
        grant_id: "g-1",
        role_id: "r-1",
        role_name_ko: "HR",
        valid_from: "2026-01-01T00:00:00Z",
        caveats: [],
      },
    ],
  };
  const markup = renderNode("/", <Home canOrgStructure />);
  expect(markup).not.toContain('data-pattern="worklist"');
  expect(markup).not.toContain("data-deadline-strip");
  expect(state.reads).not.toContain("/api/v1/employees/facets");
  expect(state.reads).not.toContain("/api/v1/org-structure");
});

test.each(["baseline", "console"] as const)("the %s home page is headed by the inbox title, not a greeting", experience => {
  state.experience = experience;
  expect(renderNode("/", <Home canOrgStructure={false} />).match(/<h1\b[^>]*>([^<]*)<\/h1>/)?.[1]).toBe(t("home.inbox.title"));
});

test("Console Worklist gates lower band reads for unpermitted users", () => {
  const markup = renderNode("/", <Home canOrgStructure={false} />);
  expect(markup).toContain('data-pattern="worklist"');
  expect(markup).toContain("data-deadline-strip");
  expect(markup).toContain(t("home.worklist.statutoryOnly"));
  expect(markup).toContain(t("home.worklist.statutoryBadge"));
  expect(markup).toContain(t("home.worklist.moreCount", { count: 10 }));
  expect(state.reads).not.toContain("/api/v1/employees/facets");
  expect(state.reads).not.toContain("/api/v1/org-structure");
});

test("Console WorklistLower renders headcount (ON_LEAVE/LEAVE fallback and PRE_HIRE), people checks, and entity meters when permitted", () => {
  state.access = {
    is_ops: false,
    entries: [{ domain: "hr_basic", level: "view", enforcement: "ENFORCED", scope: { kind: "TENANT", include_descendants: true }, grant_id: "g-1", role_id: "r-1", role_name_ko: "HR", valid_from: "2026-01-01T00:00:00Z", caveats: [] }],
  };
  state.facets = {
    total: 2054,
    status: [{ value: "ACTIVE", count: 2054 }, { value: "LEAVE", count: 37 }, { value: "PRE_HIRE", count: 25 }],
    employment_type: [], legal_entity: [], workplace: [],
    review: { identity_review_required: 0, register_review_required: 546, home_branch_review_required: 0, lifecycle_apply_failed: 0, contract_ended: 0, contract_ending_before: 42 },
  };
  state.structure = {
    tenant_name: "Saeon", phase: "OPERATING", unplaced: [],
    entities: [{
      id: "ent-1", kind: "LEGAL_ENTITY", name: "Saeon Precision", version: 1, headcount: 757, direct_headcount: 0, dispatched_headcount: 0, chips: [],
      children: [{ id: "wp-1", kind: "WORKPLACE", name: "Plant 1", version: 1, headcount: 757, direct_headcount: 0, dispatched_headcount: 0, chips: [], children: [] }],
    }],
  };

  const markup = renderNode("/", <Home canOrgStructure />);
  expect(state.reads).toContain("/api/v1/employees/facets");
  expect(state.reads).toContain("/api/v1/org-structure");
  expect(markup).toMatch(new RegExp(`<h1\\b[^>]*id="home-title"[^>]*>${t("home.inbox.title")}</h1>`));
  expect(markup).toContain(inboxLink());
  expect(markup).toContain(t("home.worklist.headcount"));
  expect(markup).toContain(t("home.asOf", { time: "2026-11-10" }));
  expect(markup).toContain(t("home.worklist.contractEnding"));
  expect(markup).toContain("2,054");
  expect(markup).toContain("37");
  expect(markup).toContain("25");
  expect(markup).toContain("Saeon Precision");
  expect(markup).toContain('role="meter"');
  expect(markup).toContain(t("home.worklist.siteCount", { count: 1 }));
});

test("Console /inbox supports queue selection with record pane and non-queue tabs", () => {
  const queueMarkup = renderNode("/inbox?sel=stat-1", <InboxPage canOrgStructure={false} />);
  expect(queueMarkup).toContain('data-pattern="worklist"');
  expect(queueMarkup).toContain(t("home.worklist.selectedMeta"));
  expect(queueMarkup).toContain("INS-1");

  const doneMarkup = renderNode("/inbox?tab=done", <InboxPage canOrgStructure={false} />);
  expect(doneMarkup).toContain('data-pattern="worklist"');
  expect(doneMarkup).toContain(`aria-current="page" href="/inbox?tab=done"`);
  expect(doneMarkup).not.toContain("data-deadline-strip");
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { liveApplying } from "../../../lib/live/live";
import { readIdentity } from "../../../lib/query";
import { Button } from "../../../ui/button/button";
import type { AttentionInboxItem, AttentionInboxResponse } from "../domain/inbox-filter";
import { buildPeopleChecks } from "../domain/worklist-lower-checks";
import { InboxPage } from "./inbox-page";
import { WorklistLower } from "./worklist-lower";
import { CompactSubject } from "./worklist-subject";

const state = vi.hoisted(() => ({
  facets: undefined as
    | {
        total: number;
        status: { value: string; count: number }[];
        employment_type: unknown[];
        legal_entity: unknown[];
        workplace: unknown[];
        review: {
          identity_review_required: number;
          register_review_required: number;
          home_branch_review_required: number;
          lifecycle_apply_failed: number;
          contract_ended: number;
          contract_ending_before: number;
        };
      }
    | undefined,
  access: { is_ops: false, entries: [] as unknown[] },
  inboxPending: false,
  inboxError: false,
  inboxPages: [] as AttentionInboxResponse[],
}));

vi.mock("../../../experience/dom", async original => ({
  ...(await original<typeof import("../../../experience/dom")>()),
  useActiveExperienceId: () => "console" as const,
}));

vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: Parameters<typeof readIdentity>[0] & { enabled?: boolean }) => {
    if (options.enabled === false) {
      return { data: undefined, isPending: true, isFetching: false, isError: false, isSuccess: false, isFetchedAfterMount: false };
    }
    const path = String(JSON.parse(readIdentity(options))[0]);
    if (path === "/api/v1/users/me") {
      return {
        data: { display_name: "Tester", tenant: { name: "Corp", phase: "OPERATING", go_live_at: null } },
        isPending: false,
        isFetching: false,
        isError: false,
        isSuccess: true,
        isFetchedAfterMount: true,
        dataUpdatedAt: 1,
      };
    }
    if (path === "/api/v1/access/me") {
      return { data: state.access, isPending: false, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true };
    }
    if (path === "/api/v1/employees/facets") {
      return { data: state.facets, isPending: false, isFetching: false, isError: false, isSuccess: Boolean(state.facets) };
    }
    return { data: { items: [] }, isPending: false, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true };
  },
  useInfiniteQuery: (options: Parameters<typeof readIdentity>[0]) => {
    const parsed = JSON.parse(readIdentity(options)) as [string, { query?: { filter?: string } }?];
    const isQueue = parsed[0] === "/api/v1/me/action-inbox" && parsed[1]?.query?.filter !== "notices";
    return {
      data: isQueue && (state.inboxPending || state.inboxError)
        ? undefined
        : { pages: isQueue ? state.inboxPages : [{ items: [], next_cursor: null }] },
      isPending: isQueue ? state.inboxPending : false,
      isFetching: false,
      isError: isQueue ? state.inboxError : false,
      error: isQueue && state.inboxError ? new Error("inbox failed") : null,
      isSuccess: !(isQueue && (state.inboxPending || state.inboxError)),
      isPlaceholderData: false,
      dataUpdatedAt: isQueue && state.inboxPending ? 0 : 1,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
      refetch: vi.fn(),
    };
  },
}));

const makeItem = (extra: Partial<AttentionInboxItem> = {}): AttentionInboxItem => ({
  id: "item-1",
  kind: "org_change_approve",
  lane: "turn",
  title: "Org Reorg",
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

const renderNode = (url: string, node: React.ReactNode) =>
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
  state.facets = undefined;
  state.access = { is_ops: false, entries: [] };
  state.inboxPending = false;
  state.inboxError = false;
  state.inboxPages = [
    {
      items: [makeItem()],
      total: 1,
      total_is_exact: true,
      next_cursor: null,
      unavailable: [],
      available_filters: ["turn", "waiting"],
      counts: { turn: { total: 1, total_is_exact: true } },
      upcoming: [],
      has_work: true,
      quick_starts: [],
      as_of: "2026-11-10T09:00:00+09:00",
    },
  ];
});

test("buildPeopleChecks and WorklistLower map hire/contractEnd/career safely without crashing", () => {
  const review = {
    identity_review_required: 0,
    register_review_required: 3,
    home_branch_review_required: 0,
    lifecycle_apply_failed: 0,
    contract_ended: 0,
    contract_ending_before: 0,
  };
  const missingItems: AttentionInboxItem[] = [
    makeItem({ id: "reg-hire", kind: "register_review", context: { review_count: 1, register: { missing_fields: ["hire"] } } }),
    makeItem({ id: "reg-contract-end", kind: "register_review", context: { review_count: 1, register: { missing_fields: ["contractEnd"] } } }),
    makeItem({ id: "reg-career", kind: "register_review", context: { review_count: 1, register: { missing_fields: ["career"] } } }),
  ];
  const rows = buildPeopleChecks(review, missingItems);
  expect(rows.filter(r => r.indent).map(r => r.missingFieldKey)).toEqual([
    "empCard.reg.item.contract",
    "empCard.reg.item.contract",
    "empCard.reg.item.history",
  ]);

  state.access = {
    is_ops: false,
    entries: [{ domain: "hr_basic", level: "view", enforcement: "ENFORCED", scope: { kind: "TENANT", include_descendants: true }, grant_id: "g-1", role_id: "r-1", role_name_ko: "HR", valid_from: "2026-01-01T00:00:00Z", caveats: [] }],
  };
  state.facets = {
    total: 10,
    status: [{ value: "ACTIVE", count: 10 }],
    employment_type: [],
    legal_entity: [],
    workplace: [],
    review,
  };
  const html = renderNode("/", <WorklistLower items={missingItems} canOrgStructure={false} />);
  expect(html).toContain(t("home.worklist.peopleSubMissing", { field: t("empCard.reg.item.contract") }));
  expect(html).toContain(t("home.worklist.peopleSubMissing", { field: t("empCard.reg.item.history") }));
});

test("WorklistLower renders action for exceptionId, distinguishes unlock status, and handles payroll with due", () => {
  const unlockWithException = makeItem({
    id: "unlock-exc-1",
    kind: "period_unlock",
    title: "Attendance 2026-10 Unlock",
    links: [{ kind: "period_lock", id: "00000000-0000-4000-8000-000000000901" }],
    context: {
      unlock: {
        domain: "attendance",
        periodStart: "2026-10-01",
        periodEnd: "2026-10-31",
        requester: "Kim",
        reason_code: "RETRO_CORRECTION",
        exceptionId: "00000000-0000-4000-8000-000000000902",
      },
    },
  });
  const payrollWithDue = makeItem({
    id: "pay-due-1",
    kind: "payroll",
    title: "2026-10 Payroll",
    due: "2026-11-25T00:00:00+09:00",
    days_remaining: 15,
    links: [{ kind: "pay_run", id: "00000000-0000-4000-8000-000000000903" }],
    context: { reason: "Payday 11-25 · Missing bank 2" },
  });

  const html = renderNode(
    "/",
    <WorklistLower
      items={[unlockWithException, payrollWithDue]}
      action={row =>
        row.context?.unlock?.exceptionId ? (
          <Button size="sm">{t("periodLocks.review.acknowledge")}</Button>
        ) : null
      }
      canOrgStructure={false}
    />,
  );
  expect(html).toContain(t("periodLocks.review.acknowledge"));
  expect(html).toContain(t("periodLocks.request.chip.PENDING"));
  expect(html).not.toContain(t("home.worklist.opsState.beforeClose"));
  expect(html).toContain("Missing bank 2");
  expect(html).not.toContain("Payday 11-25 · Missing bank 2");
  expect(html).toContain("11-25");
});

test("WorklistConsole gates non-queue and queue InboxTabs and asOf during applying, inbox.isPending, and inbox.isError", () => {
  const applyingSpy = vi.spyOn(liveApplying, "get").mockReturnValue(true);
  try {
    const applyingDone = renderNode("/inbox?tab=done", <InboxPage canOrgStructure={false} />);
    expect(applyingDone).not.toContain(t("home.inbox.tab.waiting"));
    expect(applyingDone).not.toContain("<time");
  } finally {
    applyingSpy.mockRestore();
  }

  state.inboxPending = true;
  for (const url of ["/inbox", "/inbox?tab=done"]) {
    const html = renderNode(url, <InboxPage canOrgStructure={false} />);
    expect(html, url).not.toContain(t("home.inbox.tab.waiting"));
    expect(html, url).not.toContain("<time");
  }

  state.inboxPending = false;
  state.inboxError = true;
  for (const url of ["/inbox", "/inbox?tab=reference"]) {
    const html = renderNode(url, <InboxPage canOrgStructure={false} />);
    expect(html, url).not.toContain(t("home.inbox.tab.waiting"));
    expect(html, url).not.toContain("<time");
  }
});

test("CompactSubject keeps non-empty subject title when distinct task lead lacks site, ref, and structured context", () => {
  const bareItem = makeItem({
    id: "bare-1",
    kind: "hr_request",
    title: "Special HR Review",
    ref: "",
    site: undefined,
    who: undefined,
    context: undefined,
  });
  const html = renderNode("/", <CompactSubject item={bareItem} />);
  expect(html).toContain('title="Special HR Review"');
  expect(html).toContain("Special HR Review");
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { readIdentity } from "../lib/query";
import { commitLabel } from "../ui/composer/actions";
import type { AttentionInboxItem } from "../features/home/domain/inbox-filter";
import { consoleInlineRowAction, consoleRecordBody, consoleRecordFooter, inboxAction } from "./inbox-action";

vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: Parameters<typeof readIdentity>[0]) => {
    const path = String(JSON.parse(readIdentity(options))[0]);
    if (path === "/api/v1/org-units") {
      return {
        data: { items: [{ id: "u-2", name: "Unit Two", headcount: 18 }, { id: "u-3", name: "Unit Three", headcount: 12 }] },
        isPending: false,
        isFetching: false,
        isError: false,
        isSuccess: true,
      };
    }
    if (path === "/api/v1/org-changes/{id}") {
      return {
        data: {
          id: "change-action-test",
          code: "OC-2026-0999",
          kind: "REORG",
          status: "IN_APPROVAL",
          target: { kind: "ORG_UNIT", ref: "u-2", label: "Merge units" },
          effectiveDate: "2026-12-01",
          reason: "Consolidation",
          headcount: 12,
          siteCount: 1,
          teamCount: 2,
          draftedBy: "user-1",
          draftedByName: "Lee",
          createdAt: "2026-11-01T00:00:00Z",
          updatedAt: "2026-11-01T00:00:00Z",
          proposal: [
            { op: "REASSIGN_ORG_UNIT", fromOrgUnit: "u-3", toOrgUnit: "u-2", scope: { company: "c-1" } },
            { op: "DISSOLVE_ORG_UNIT", orgUnitId: "u-3", mergedInto: "u-2" },
          ],
          approvalSteps: [{ id: "s-1", stepOrder: 1, roleKey: "executive", decision: "PENDING", decidedByName: null }],
          settlementItems: [],
          events: [],
        },
        isPending: false,
        isFetching: false,
        isError: false,
        isFetchedAfterMount: true,
        isSuccess: true,
      };
    }
    if (path === "/api/v1/approvals/{id}") {
      return {
        data: {
          id: "run-action-test",
          box: "pending",
          title: "Leave approval",
          summary: "Lee · 12-01 ~ 2027-11-30",
          document_no: "AP-2026-0192",
          decision_refusal: null,
          source: { key: "leave", label: "Leave" },
          status: { key: "IN_APPROVAL" },
          requester: { id: "u-1", name: "Lee" },
          requested_at: "2026-11-09T09:00:00+09:00",
          facts: [],
          route: [{ id: "st-1", role_key: "hr", assignee: "Moon", state: "current" }],
          viewer: { kind: "org_change", id: "run-action-test" },
          body: [],
          revision: 1,
          fingerprint: "fp-1",
          consequence: "final",
          opinion_max: 500,
          my_actions: { kind: "approve", reject: { consequence: "request_ends", reason_domain: "org_change_reject" } },
        },
        isPending: false,
        isFetching: false,
        isError: false,
        isFetchedAfterMount: true,
        isSuccess: true,
      };
    }
    return { data: undefined, isPending: false, isFetching: false, isError: false, isSuccess: true, isFetchedAfterMount: true };
  },
}));

beforeAll(() => loadCatalog("ko"));

test("inboxAction, consoleInlineRowAction, and consoleRecordBody enforce can_decide and emit distinct diffs", () => {
  const item: AttentionInboxItem = {
    id: "action-test-item",
    kind: "org_change_approve",
    lane: "turn",
    title: "Merge units",
    ref: "OC-2026-0999",
    urg: "wait",
    due: "2026-12-01T00:00:00+09:00",
    dueTone: "neutral",
    done: false,
    days_remaining: 21,
    can_decide: false,
    links: [{ kind: "org_change", id: "change-action-test" }],
    context: { command: "approve", drafter: "Lee", reason: "Pending decision" },
  };
  expect(consoleInlineRowAction(item, "home-title", vi.fn())).toBeNull();
  expect(inboxAction(item, "home-title")).toBeNull();

  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderWithQc = (node: React.ReactNode) =>
    renderToStaticMarkup(<QueryClientProvider client={client}>{node}</QueryClientProvider>);

  const decidableMarkup = renderWithQc(inboxAction({ ...item, can_decide: true }, "home-title"));
  expect(decidableMarkup).toContain(commitLabel({ kind: "orgChange", mode: "approve" }));

  const bodyMarkup = renderWithQc(consoleRecordBody(item));
  expect(bodyMarkup).toContain("Unit Two");
  expect(bodyMarkup).toContain(t("home.worklist.personCount", { count: 18 }));
  expect(bodyMarkup).toContain(t("home.worklist.personCount", { count: 30 }));
  expect(bodyMarkup).toContain("Unit Three");
  expect(bodyMarkup).toContain(t("home.worklist.personCount", { count: 12 }));
  expect(bodyMarkup).toContain(t("orgPropose.diff.chip.dissolved"));

  const leaveItem: AttentionInboxItem = {
    id: "leave-app-1",
    kind: "approval",
    lane: "turn",
    title: "Leave approval",
    ref: "",
    urg: "wait",
    due: "2026-11-15T09:00:00+09:00",
    dueTone: "warn",
    done: false,
    days_remaining: 5,
    can_decide: true,
    links: [{ kind: "approval_run", id: "run-action-test" }],
  };
  const leaveInline = renderWithQc(consoleInlineRowAction(leaveItem, "home-title", vi.fn()));
  expect(leaveInline).toContain(t("uiWorklist.reject"));
  expect(leaveInline).toContain(t("uiWorklist.approve"));
  expect(consoleInlineRowAction({ ...leaveItem, can_decide: false }, "home-title", vi.fn())).toBeNull();

  const leaveBody = renderWithQc(consoleRecordBody(leaveItem));
  expect(leaveBody).toContain("AP-2026-0192");
  expect(leaveBody).toContain("Lee");
  const leaveFooterDenied = renderWithQc(consoleRecordFooter({ ...leaveItem, can_decide: false }, "home-title", vi.fn()));
  expect(leaveFooterDenied).toContain(t("approvals.viewer.unavailable"));
});

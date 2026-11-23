// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { ALL_OPTIONAL_WORKLIST_COLUMNS } from "../domain/inline-decide";
import { GroupedQueue, reasonLines } from "./grouped-queue";
import { WorklistLower } from "./worklist-lower";
import { WorklistSchedule } from "./worklist-schedule";
import { ConsoleWorklistTable } from "./worklist-table";

vi.mock("@tanstack/react-query", async original => ({
  ...(await original<typeof import("@tanstack/react-query")>()),
  useQuery: (options: { enabled?: boolean }) =>
    options.enabled === false
      ? { data: undefined, isPending: true, isFetching: false, isError: false, isSuccess: false }
      : { data: { is_ops: false, entries: [] }, isPending: false, isFetching: false, isError: false, isSuccess: true },
}));

const makeItem = (extra: Partial<AttentionInboxItem> = {}): AttentionInboxItem => ({
  id: "edge-item-1",
  kind: "period_unlock",
  lane: "turn",
  title: "Oct Attendance",
  ref: "",
  urg: "today",
  due: "2026-11-12T00:00:00+09:00",
  dueTone: "warn",
  done: false,
  days_remaining: 2,
  links: [{ kind: "period_lock", id: "pl-1" }],
  ...extra,
});

const renderPart = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RouterContextProvider
        router={createRouter({
          routeTree: createRootRoute(),
          history: createMemoryHistory({ initialEntries: ["/"] }),
        })}
      >
        {node}
      </RouterContextProvider>
    </QueryClientProvider>,
  );

beforeAll(() => loadCatalog("ko"));

test("WorklistSchedule labels period_unlock with context.unlock (no exceptionId) as unlock, and without unlock as attendance", () => {
  const stripHtml = renderPart(
    <WorklistSchedule
      items={[
        makeItem({
          id: "unlock-req-1",
          title: "Payroll Unlock",
          context: {
            unlock: {
              domain: "payroll",
              periodStart: "2026-10-01",
              periodEnd: "2026-10-31",
              requester: "Kim",
              reason_code: "RETRO_CORRECTION",
            },
          },
        }),
        makeItem({ id: "att-close-1", title: "Attendance Close", due: "2026-11-11T00:00:00+09:00", days_remaining: 1, context: {} }),
      ]}
      asOf="2026-11-10T09:00:00+09:00"
    />,
  );
  expect(stripHtml).toContain(`aria-label="${t("home.worklist.strip.unlock")} · ${t("home.part.unlocks")} · Payroll Unlock">${t("home.worklist.strip.unlock")}<`);
  expect(stripHtml).not.toContain(`${t("home.worklist.strip.attendance")} · ${t("home.part.unlocks")}`);
  expect(stripHtml).toContain(`aria-label="${t("home.worklist.attendanceClose")} · Attendance Close">${t("home.worklist.strip.attendance")}<`);
});

test("reasonLines and consoleReasonText suppress attendance-close fallback, trim whitespace-only reasons, and strip padded task labels", () => {
  const attMissingReason = makeItem({ id: "att-none", context: {} });
  const attEmptyReason = makeItem({ id: "att-empty", context: { reason: "" } });
  const attPaddedTaskLabel = makeItem({ id: "att-padded", context: { reason: `  ${t("home.worklist.attendanceClose")}  ` } });
  const wsOnlyRequest = makeItem({ id: "req-ws", kind: "hr_request", title: "Profile Fix", links: [{ kind: "change_request", id: "cr-1" }], context: { reason: "   " } });
  const paddedTaskRequest = makeItem({ id: "req-padded", kind: "hr_request", title: "Profile Fix", links: [{ kind: "change_request", id: "cr-2" }], context: { reason: `  ${t("home.part.requests")}  ` } });

  expect(reasonLines(attMissingReason)).toEqual([]);
  expect(reasonLines(attEmptyReason)).toEqual([]);
  expect(reasonLines(attPaddedTaskLabel)).toEqual([]);
  expect(reasonLines(wsOnlyRequest)).toEqual([t("home.inbox.reason.hr_request")]);
  expect(reasonLines(paddedTaskRequest)).toEqual([t("home.inbox.reason.hr_request")]);

  const tableHtml = renderPart(
    <ConsoleWorklistTable
      items={[attMissingReason, attEmptyReason, attPaddedTaskLabel, wsOnlyRequest, paddedTaskRequest]}
      checkedIds={new Set()}
      onToggleCheck={vi.fn()}
      onToggleAll={vi.fn()}
      shownCols={new Set(ALL_OPTIONAL_WORKLIST_COLUMNS)}
    />,
  );
  expect(tableHtml).not.toContain(t("home.inbox.reason.period_unlock"));
  expect(tableHtml).not.toContain(`title="  ${t("home.worklist.attendanceClose")}  "`);
  expect(tableHtml).not.toContain(`title="  ${t("home.part.requests")}  "`);
  expect(tableHtml).toContain(`title="${t("home.inbox.reason.hr_request")}"`);
  expect(tableHtml).not.toContain(`${t("home.inbox.reason.hr_request")} ·`);

  const foldedAttHtml = renderPart(
    <GroupedQueue
      items={[
        makeItem({ id: "att-f1", fold_key: "att", title: "Site A", context: {} }),
        makeItem({ id: "att-f2", fold_key: "att", title: "Site B", context: {} }),
      ]}
    />,
  );
  expect(foldedAttHtml).toContain(t("home.inbox.foldCount", { kind: t("home.worklist.attendanceClose"), count: 2 }));
  expect(foldedAttHtml).not.toContain(t("home.inbox.foldCount", { kind: t("home.part.unlocks"), count: 2 }));

  const lowerEmptyReasonHtml = renderPart(<WorklistLower items={[attEmptyReason]} canOrgStructure={false} />);
  expect(lowerEmptyReasonHtml).toContain("Oct Attendance");
});

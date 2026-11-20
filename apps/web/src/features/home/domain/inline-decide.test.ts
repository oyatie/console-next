// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "vitest";
import type { AttentionInboxItem } from "./inbox-filter";
import {
  buildScheduleWindow,
  inlineDecisionClass,
  isInlineApprovalDecidable,
  isStatutoryDeadline,
  shortMonthDay,
  sortWorklistItems,
} from "./inline-decide";

const sample = (extra: Partial<AttentionInboxItem> = {}): AttentionInboxItem => ({
  id: "item-1",
  kind: "register_review",
  lane: "turn",
  title: "Sample",
  ref: "",
  urg: "wait",
  dueTone: "neutral",
  done: false,
  days_remaining: null,
  links: [],
  ...extra,
});

test("inlineDecisionClass matches only server-authorized command and canonical link pairs", () => {
  expect(
    inlineDecisionClass(
      sample({
        kind: "org_change_approve",
        links: [{ kind: "org_change", id: "c1" }],
        context: { command: "approve" },
      }),
    ),
  ).toBe("approval");
  expect(
    isInlineApprovalDecidable(
      sample({
        kind: "org_change_approve",
        links: [{ kind: "org_change", id: "c1" }],
        context: { command: "approve" },
        can_decide: false,
      }),
    ),
  ).toBe(false);
  expect(
    inlineDecisionClass(
      sample({
        kind: "org_change_approve",
        links: [{ kind: "employee", id: "e1" }],
        context: { command: "approve" },
      }),
    ),
  ).toBeNull();
  expect(
    inlineDecisionClass(
      sample({
        kind: "period_unlock",
        links: [{ kind: "period_lock", id: "p1" }],
        context: {
          unlock: {
            domain: "payroll",
            periodStart: "2026-10-01",
            periodEnd: "2026-10-31",
            requester: null,
            reason_code: "CORRECTION",
            exceptionId: "00000000-0000-4000-8000-000000000001",
          },
        },
      }),
    ),
  ).toBe("unlock_ack");
});

test("isStatutoryDeadline and schedule helpers preserve KST day boundaries and undated tail order", () => {
  const statutory = sample({
    id: "s1",
    due: "2026-11-14T00:00:00+09:00",
    due_basis: "statutory",
  });
  const overdue = sample({
    id: "o1",
    due: "2026-11-08T00:00:00+09:00",
  });
  const undated = sample({ id: "u1" });

  expect(isStatutoryDeadline(statutory)).toBe(true);
  expect(isStatutoryDeadline(overdue)).toBe(false);
  expect(shortMonthDay(statutory.due)).toBe("11-14");

  const schedule = buildScheduleWindow([statutory, overdue, undated], "2026-11-10T09:00:00+09:00");
  expect(schedule.monthNumber).toBe(11);
  expect(schedule.days.find(d => d.date === "2026-11-08")?.bucket).toBe("over");
  expect(schedule.days.find(d => d.date === "2026-11-10")?.bucket).toBe("today");
  expect(schedule.days.find(d => d.date === "2026-11-14")?.bucket).toBe("upcoming");

  expect(sortWorklistItems([undated, statutory, overdue], "due", "asc").map(i => i.id)).toEqual([
    "o1",
    "s1",
    "u1",
  ]);
  expect(sortWorklistItems([undated, statutory, overdue], "due", "desc").map(i => i.id)).toEqual([
    "s1",
    "o1",
    "u1",
  ]);
});

test("buildScheduleWindow keeps today and near-term items in range when far-overdue or far-future items exist", () => {
  const veryOld = sample({ id: "old-35", due: "2026-10-06T09:00:00+09:00" });
  const dueToday = sample({ id: "due-today", due: "2026-11-10T09:00:00+09:00" });
  const dueSoon = sample({ id: "due-soon", due: "2026-11-12T09:00:00+09:00" });
  const farFuture = sample({ id: "far-future", due: "2026-12-25T09:00:00+09:00" });

  const withOld = buildScheduleWindow([veryOld, dueToday, dueSoon], "2026-11-10T09:00:00+09:00");
  expect(withOld.days.length).toBeLessThanOrEqual(28);
  expect(withOld.days.find(d => d.date === "2026-11-10")?.bucket).toBe("today");
  expect(withOld.days.some(d => d.date === "2026-11-12")).toBe(true);

  const withBoth = buildScheduleWindow([veryOld, dueToday, farFuture], "2026-11-10T09:00:00+09:00");
  expect(withBoth.days.length).toBeLessThanOrEqual(28);
  expect(withBoth.days.find(d => d.date === "2026-11-10")?.bucket).toBe("today");
});

test("sortWorklistItems and inlineDecisionClass guard invalid dates, null titles, and missing links", () => {
  const items = [
    sample({ id: "b1", due: "2026-11-15T00:00:00Z" }),
    sample({ id: "b2", due: "not-a-date" }),
    sample({ id: "b3", due: "2026-11-10T00:00:00Z" }),
  ];
  expect(sortWorklistItems(items, "due", "asc").map(i => i.id)).toEqual(["b3", "b1", "b2"]);

  const withNullTitle = [
    sample({ id: "t1", title: "Alpha" }),
    { ...sample({ id: "t2" }), title: null as unknown as string },
  ];
  expect(sortWorklistItems(withNullTitle, "task", "asc").map(i => i.id)).toEqual(["t2", "t1"]);

  const withTaskLabel = [
    sample({ id: "k1", kind: "payroll", title: "2026-10 Payroll" }),
    sample({ id: "k2", kind: "insurance_filing", title: "Statutory filing" }),
    sample({ id: "k3", kind: "payroll", title: "2026-09 Payroll" }),
  ];
  const labelOf = (item: AttentionInboxItem) => (item.kind === "payroll" ? "Payroll" : "Insurance");
  expect(sortWorklistItems(withTaskLabel, "task", "asc", labelOf).map(i => i.id)).toEqual(["k2", "k3", "k1"]);

  const missingLinks = { ...sample({ id: "no-links" }), links: undefined as unknown as AttentionInboxItem["links"] };
  expect(inlineDecisionClass(missingLinks)).toBeNull();
});

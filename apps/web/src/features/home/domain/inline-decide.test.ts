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

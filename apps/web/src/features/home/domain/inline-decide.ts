// SPDX-License-Identifier: LicenseRef-Proprietary
import { kstDayIso, shortMonthDay } from "../../../lib/pure/today";
import type { AttentionInboxItem } from "./inbox-filter";

export { kstDayIso, shortMonthDay };

type InlineDecisionClass =
  | "approval"
  | "effectuate"
  | "unlock_ack"
  | "binding_review"
  | "passkey";

type ClassRule = {
  readonly id: InlineDecisionClass;
  readonly matches: (item: AttentionInboxItem) => boolean;
};

/**
 * Explicit registry of inbox item classes that expose an authorized inline command on the worklist row.
 * Every entry requires both the server-emitted command/context fact and its registered canonical link kind.
 */
const INLINE_DECIDABLE_CLASSES: readonly ClassRule[] = [
  {
    id: "approval",
    matches: item =>
      item.links[0]?.kind === "org_change" &&
      item.context?.command === "approve" &&
      item.can_decide !== false,
  },
  {
    id: "effectuate",
    matches: item =>
      item.links[0]?.kind === "org_change" && item.context?.command === "effectuate",
  },
  {
    id: "unlock_ack",
    matches: item =>
      item.links[0]?.kind === "period_lock" && Boolean(item.context?.unlock?.exceptionId),
  },
  {
    id: "binding_review",
    matches: item =>
      item.kind === "account_binding_review" && Boolean(item.context?.command_id),
  },
  {
    id: "passkey",
    matches: item => item.kind === "account_security" && item.links[0]?.kind === "account",
  },
];

export function inlineDecisionClass(item: AttentionInboxItem): InlineDecisionClass | null {
  for (const entry of INLINE_DECIDABLE_CLASSES) {
    if (entry.matches(item)) return entry.id;
  }
  return null;
}

export function isInlineApprovalDecidable(item: AttentionInboxItem): boolean {
  return inlineDecisionClass(item) === "approval";
}

export function isStatutoryDeadline(item: AttentionInboxItem): boolean {
  return item.due_basis === "statutory";
}

const DAY_MS = 24 * 60 * 60 * 1000;

function addDaysIso(dayIso: string, delta: number): string {
  const [y, m, d] = dayIso.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m! - 1, d!) + delta * DAY_MS);
  const ny = next.getUTCFullYear();
  const nm = String(next.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(next.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

type ScheduleDayColumn = {
  date: string;
  dayLabel: string;
  bucket: "over" | "today" | "upcoming";
};

export function buildScheduleWindow(
  items: readonly AttentionInboxItem[],
  asOf?: string | null,
): {
  monthNumber: number;
  rangeLabel: string;
  days: ScheduleDayColumn[];
} {
  const anchor = kstDayIso(asOf) ?? "2026-11-10";
  const dated = items
    .map(item => kstDayIso(item.due))
    .filter((d): d is string => d !== null)
    .sort();

  let start = addDaysIso(anchor, -3);
  let end = addDaysIso(anchor, 14);
  if (dated.length > 0) {
    if (dated[0]! < start) start = dated[0]!;
    if (dated[dated.length - 1]! > end) end = dated[dated.length - 1]!;
  }
  const maxEnd = addDaysIso(start, 27);
  if (end > maxEnd) end = maxEnd;

  const days: ScheduleDayColumn[] = [];
  let cursor = start;
  while (cursor <= end && days.length < 28) {
    days.push({
      date: cursor,
      dayLabel: cursor.slice(8, 10),
      bucket: cursor < anchor ? "over" : cursor === anchor ? "today" : "upcoming",
    });
    cursor = addDaysIso(cursor, 1);
  }

  const monthNumber = Number(anchor.slice(5, 7));
  const rangeLabel = `${start.slice(5)} ~ ${days[days.length - 1]!.date.slice(5)}`;
  return { monthNumber, rangeLabel, days };
}

export type OptionalWorklistColumn = "date" | "reason" | "statutory" | "action";
export const ALL_OPTIONAL_WORKLIST_COLUMNS: readonly OptionalWorklistColumn[] = [
  "date",
  "reason",
  "statutory",
  "action",
];

export type WorklistSortField = "due" | "task";

export function sortWorklistItems(
  items: readonly AttentionInboxItem[],
  field: WorklistSortField,
  direction: "asc" | "desc",
): AttentionInboxItem[] {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    if (field === "task") {
      return sign * a.title.localeCompare(b.title, "ko");
    }
    if (!a.due && !b.due) return 0;
    if (!a.due) return 1;
    if (!b.due) return -1;
    return sign * (Date.parse(a.due) - Date.parse(b.due));
  });
}

/** Canonical workspace-tab href for a worklist item's primary link. */
export function worklistItemHref(item: AttentionInboxItem): string | null {
  const link = item.links[0];
  if (!link) return null;
  switch (link.kind) {
    case "org_change":
      return `/org/changes/${encodeURIComponent(link.id)}`;
    case "employee":
      return `/people/${encodeURIComponent(link.id)}`;
    case "privacy_request":
      return `/account/privacy/intake/${encodeURIComponent(link.id)}`;
    case "change_request":
      return `/people/requests?sel=${encodeURIComponent(link.id)}`;
    case "exit_case":
      return `/people/exits/${encodeURIComponent(link.id)}`;
    case "period_lock":
      return `/people/period-locks?review=${encodeURIComponent(link.id)}`;
    case "statutory":
      return `/statutory?event=${encodeURIComponent(link.id)}`;
    case "support_session":
      return `/audit/support-access?review=${encodeURIComponent(link.id)}`;
    case "identifier_correction":
      return `/org/entities?correction=${encodeURIComponent(link.id)}#identifier-corrections`;
    case "registration_check": {
      const [entityId, regId] = link.id.split("/");
      return entityId && regId
        ? `/org/entities/${encodeURIComponent(entityId)}?nts=${encodeURIComponent(regId)}`
        : null;
    }
    case "account":
      return "/account";
    default:
      return null;
  }
}

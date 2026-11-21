// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { AlertTriangle, Check as CheckIcon } from "lucide-react";
import { type StatRowItem } from "../../../ui/key-value/key-value";
import { selectionCount, type Selection } from "../../../ui/long-table/selection";
import type { Review, StatusView } from "../domain/roster";
import type { RosterOrder } from "../domain/roster-order";

type Employee = components["schemas"]["Employee"];
export type EmpType = "REGULAR" | "CONTRACT" | "PART_TIME";

export const CHOSUNG = [0x3131, 0x3134, 0x3137, 0x3139, 0x3141, 0x3142, 0x3145, 0x3147, 0x3148, 0x314a, 0x314b, 0x314c, 0x314d, 0x314e].map(c =>
  String.fromCharCode(c),
);
const CHOSUNG_MAP = [
  0x3131, 0x3131, 0x3134, 0x3137, 0x3137, 0x3139, 0x3141, 0x3142, 0x3142, 0x3145, 0x3145, 0x3147, 0x3148, 0x3148,
  0x314a, 0x314b, 0x314c, 0x314d, 0x314e,
].map(c => String.fromCharCode(c));

function hangulInitial(name: string): string | null {
  const code = name.trim().charCodeAt(0);
  if (!Number.isFinite(code) || code < 0xac00 || code > 0xd7a3) return null;
  return CHOSUNG_MAP[Math.floor((code - 0xac00) / 588)] ?? null;
}

export function toOrderField(sort: RosterOrder): { field: "name" | "employee_number" | "hire_date"; direction: "asc" | "desc" } {
  const desc = sort.startsWith("-");
  const raw = desc ? sort.slice(1) : sort;
  const field = raw === "employee_number" || raw === "hire_date" ? raw : "name";
  return { field, direction: desc ? "desc" : "asc" };
}

export function filterConsoleRows(
  rows: readonly Employee[],
  {
    empTypes,
    addressMissingOnly,
    probationOnly,
    activeChosung,
  }: {
    empTypes: ReadonlySet<EmpType>;
    addressMissingOnly: boolean;
    probationOnly: boolean;
    activeChosung: string | null;
  },
) {
  return rows.filter(row => {
    if (empTypes.size > 0 && (!row.employment_type || !empTypes.has(row.employment_type as EmpType))) return false;
    if (addressMissingOnly && !row.register_review_required) return false;
    if (probationOnly && row.next_event?.event_type !== "PROMOTE") return false;
    if (activeChosung && hangulInitial(row.name) !== activeChosung) return false;
    return true;
  });
}

export function buildStatItems({
  status,
  review,
  statusTotals,
  registerMissingCount,
  setFilter,
}: {
  status: StatusView;
  review: readonly Review[];
  statusTotals: Partial<Record<"ACTIVE" | "ON_LEAVE" | "PRE_HIRE" | "EXITED", number>>;
  registerMissingCount: number;
  setFilter: (patch: { status?: StatusView; review?: Review[] }) => void;
}): StatRowItem[] {
  const isActiveView = status === "ACTIVE" || status === "current";
  return [
    {
      key: "active",
      label: (
        <>
          {isActiveView && !review.includes("register") ? <CheckIcon size={12} aria-hidden="true" /> : null}
          <bdi>{t(isActiveView ? "people.stat.activeViewing" : "roster.status.ACTIVE")}</bdi>
        </>
      ),
      value: statusTotals.ACTIVE !== undefined ? fmtNumber(statusTotals.ACTIVE) : "—",
      active: isActiveView && !review.includes("register"),
      onPress: () => setFilter({ status: "ACTIVE", review: [] }),
    },
    {
      key: "leave",
      label: t("roster.status.ON_LEAVE"),
      value: statusTotals.ON_LEAVE !== undefined ? fmtNumber(statusTotals.ON_LEAVE) : "—",
      active: status === "ON_LEAVE",
      onPress: () => setFilter({ status: status === "ON_LEAVE" ? "current" : "ON_LEAVE", review: [] }),
    },
    {
      key: "preHire",
      label: t("people.stat.preHire"),
      value: statusTotals.PRE_HIRE !== undefined ? fmtNumber(statusTotals.PRE_HIRE) : "—",
      active: status === "PRE_HIRE",
      onPress: () => setFilter({ status: status === "PRE_HIRE" ? "current" : "PRE_HIRE", review: [] }),
    },
    {
      key: "exited",
      label: t("people.stat.exited"),
      value: statusTotals.EXITED !== undefined ? fmtNumber(statusTotals.EXITED) : "—",
      active: status === "EXITED",
      onPress: () => setFilter({ status: status === "EXITED" ? "current" : "EXITED", review: [] }),
    },
    {
      key: "missing",
      label: (
        <>
          <AlertTriangle size={12} aria-hidden="true" />
          <bdi>{t("people.stat.missing")}</bdi>
        </>
      ),
      value: fmtNumber(registerMissingCount),
      tone: registerMissingCount > 0 ? "warn" : undefined,
      active: review.includes("register"),
      onPress: () => setFilter({ status: "current", review: review.includes("register") ? [] : ["register"] }),
    },
  ];
}

export function buildConsoleStatusSegments({
  status,
  rangeTotal,
  displayedCount,
  rangeStart,
  rangeEnd,
  sel,
  openPerson,
  sort,
}: {
  status: StatusView;
  rangeTotal: number;
  displayedCount: number;
  rangeStart: number;
  rangeEnd: number;
  sel: Selection;
  openPerson: { name: string; employee_number?: string | null } | undefined;
  sort: RosterOrder;
}) {
  const checkedCount = selectionCount(sel, rangeTotal);
  const selectedStatusText =
    checkedCount > 0 && openPerson
      ? t("people.status.barSelected", { count: checkedCount, who: `${openPerson.name} ${openPerson.employee_number ?? ""}`.trim() })
      : openPerson
        ? t("people.status.barSelected", { count: 1, who: `${openPerson.name} ${openPerson.employee_number ?? ""}`.trim() })
        : null;
  const order = toOrderField(sort);
  const activeSortLabel = order.field === "employee_number" ? t("people.col.number") : order.field === "hire_date" ? t("people.col.hired") : t("people.col.name");

  return [
    {
      id: "statusCount",
      content: t("people.status.barCount", {
        status: t(
          status === "ON_LEAVE"
            ? "roster.status.ON_LEAVE"
            : status === "PRE_HIRE"
              ? "people.stat.preHire"
              : status === "EXITED"
                ? "people.stat.exited"
                : "roster.status.ACTIVE",
        ),
        count: rangeTotal,
      }),
    },
    ...(displayedCount > 0 ? [{ id: "range", content: t("people.status.barRange", { start: rangeStart, end: rangeEnd }) }] : []),
    ...(selectedStatusText ? [{ id: "selected", tone: "strong" as const, content: selectedStatusText }] : []),
    { id: "sort", content: `${t("people.status.barSort", { label: activeSortLabel })} ${order.direction === "desc" ? "↓" : "↑"}` },
  ];
}

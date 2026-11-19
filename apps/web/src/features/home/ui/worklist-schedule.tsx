// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, t } from "@console/i18n";
import { DeadlineStrip } from "../../../ui/deadline-strip/deadline-strip";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { buildScheduleWindow, isStatutoryDeadline, kstDayIso } from "../domain/inline-decide";
import { KIND_TEXT } from "./grouped-queue";

function formatStripMonth(monthNumber: number): string {
  const locale = i18n.locale === "ko" ? "ko-KR" : "en-US";
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short" }).format(
    new Date(Date.UTC(2026, Math.max(0, monthNumber - 1), 15)),
  );
}

/** Schedule strip (`DeadlineStrip`) mapping dated and undated worklist rows onto statutory and operational lanes. */
export function WorklistSchedule({
  items,
  asOf,
  selectedId,
  onSelect,
}: {
  items: readonly AttentionInboxItem[];
  asOf?: string | null;
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const window = buildScheduleWindow(items, asOf);
  const visibleDates = new Set(window.days.map(day => day.date));
  const entries = items.map(item => {
    const day = kstDayIso(item.due);
    const tone =
      day === null
        ? ("undated" as const)
        : item.days_remaining != null && item.days_remaining < 0
          ? ("over" as const)
          : item.days_remaining === 0
            ? ("today" as const)
            : ("upcoming" as const);
    const shortLabel = t(
      item.context?.unlock?.exceptionId
        ? "periodLocks.review.title"
        : item.kind === "org_change_approve"
          ? "org.change.step.IN_APPROVAL"
          : KIND_TEXT[item.kind] ?? "home.inbox.unknown",
    );
    return {
      id: item.id,
      shortLabel,
      fullLabel: `${shortLabel} · ${item.title}`,
      lane: isStatutoryDeadline(item) ? ("statutory" as const) : ("operational" as const),
      date: day && visibleDates.has(day) ? day : null,
      tone,
    };
  });

  return (
    <DeadlineStrip
      monthLabel={formatStripMonth(window.monthNumber)}
      days={window.days}
      entries={entries}
      meta={t("home.worklist.scheduleMeta", { count: items.length, range: window.rangeLabel })}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}

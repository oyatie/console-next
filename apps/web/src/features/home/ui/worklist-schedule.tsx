// SPDX-License-Identifier: LicenseRef-Proprietary
import { i18n, t, type MessageId } from "@console/i18n";
import { DeadlineStrip } from "../../../ui/deadline-strip/deadline-strip";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { buildScheduleWindow, isStatutoryDeadline, kstDayIso, shortMonthDay } from "../domain/inline-decide";
import { taskTitleKey } from "./grouped-queue";

function formatStripMonth(monthNumber: number): string {
  const locale = i18n.locale === "ko" ? "ko-KR" : "en-US";
  return new Intl.DateTimeFormat(locale, { timeZone: "UTC", month: "short" }).format(
    new Date(Date.UTC(2026, Math.max(0, monthNumber - 1), 15)),
  );
}

const STRIP_KIND_TEXT: Record<string, MessageId> = {
  approval: "home.worklist.strip.approval",
  org_change_approve: "home.worklist.strip.approval",
  org_change: "home.worklist.strip.org",
  org_change_waiting: "home.worklist.strip.org",
  org_change_scheduled: "home.worklist.strip.org",
  org_change_apply: "home.worklist.strip.org",
  org_change_draft: "home.worklist.strip.org",
  org_change_rejected: "home.worklist.strip.org",
  org_change_settle: "home.worklist.strip.org",
  insurance_filing: "home.worklist.strip.insurance",
  hr_exit_settle: "home.worklist.strip.exitSettle",
  hr_exit: "home.worklist.strip.exit",
  hr_exit_confirm: "home.worklist.strip.exit",
  hr_exit_confirm_hq: "home.worklist.strip.exit",
  payroll: "home.worklist.strip.payroll",
  contract_renewal: "home.worklist.strip.contract",
  register_review: "home.worklist.strip.register",
  identity_review: "home.worklist.strip.identity",
  unplaced: "home.worklist.strip.unplaced",
  home_branch_review: "home.worklist.strip.unplaced",
  privacy_request: "home.worklist.strip.privacy",
  registration_check: "home.worklist.strip.nts",
  identifier_correction_waiting: "home.worklist.strip.correction",
  identifier_correction_decide: "home.worklist.strip.correction",
  identifier_correction_apply: "home.worklist.strip.correction",
  identifier_correction_review: "home.worklist.strip.correction",
  support_access: "home.worklist.strip.support",
  grant_notice: "home.worklist.strip.grant",
  account_security: "home.worklist.strip.security",
  account_binding_review: "home.worklist.strip.binding",
  hr_lifecycle: "home.worklist.strip.failed",
  lifecycle_apply_failed: "home.worklist.strip.failed",
};

function stripLabelKey(item: AttentionInboxItem): MessageId {
  const kind = item.kind === "home_branch_review" ? "unplaced" : item.kind;
  if (kind === "period_unlock") {
    return item.context?.unlock ? "home.worklist.strip.unlock" : "home.worklist.strip.attendance";
  }
  if (kind === "hr_request") {
    return isStatutoryDeadline(item) ? "home.worklist.strip.statutoryRequest" : "home.worklist.strip.request";
  }
  return STRIP_KIND_TEXT[kind] ?? "home.worklist.strip.default";
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
  const firstDate = window.days[0]?.date ?? null;
  const lastDate = window.days[window.days.length - 1]?.date ?? null;
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
    const shortLabel = t(stripLabelKey(item));
    const taskFull = t(taskTitleKey(item));
    const placedDate =
      day === null
        ? null
        : visibleDates.has(day)
          ? day
          : firstDate && day < firstDate
            ? firstDate
            : lastDate;
    const dueNote = day && !visibleDates.has(day) ? shortMonthDay(day) : null;
    return {
      id: item.id,
      shortLabel,
      fullLabel: dueNote ? `${taskFull} · ${item.title} (${dueNote})` : `${taskFull} · ${item.title}`,
      lane: isStatutoryDeadline(item) ? ("statutory" as const) : ("operational" as const),
      date: placedDate,
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

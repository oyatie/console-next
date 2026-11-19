// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { INSURER, LIFECYCLE_EVENT, codeText, label } from "../../../lib/labels";
import { reasonLabel } from "../../../lib/reason-codes";
import { domainText, periodText } from "../../../reference/periods/present";
import { Button, Check } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DueCell } from "../../../ui/due-cell/due-cell";
import { WorklistMoreBar, WorklistReason, WorklistSubject } from "../../../ui/patterns/worklist-parts";
import { Table, type Column } from "../../../ui/table";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { isStatutoryDeadline, shortMonthDay, type OptionalWorklistColumn } from "../domain/inline-decide";
import { KIND_TEXT, reasonLines, recordAction, type RowAction } from "./grouped-queue";
import s from "./worklist-console.module.css";

function CompactSubject({ item }: { item: AttentionInboxItem }) {
  const { unlock, insurance, lifecycle, request, correction } = item.context ?? {};
  const primary =
    item.kind === "privacy_request"
      ? (item.context?.privacy_kinds ?? [])
          .map(code => codeText(`account.privacy.kind.${code}`, t("enum.unknown")))
          .join(" · ")
      : unlock
        ? `${domainText(unlock.domain)} ${periodText(unlock)}`
        : request
          ? codeText(`requests.kind.${request.kind}`, t("requests.kind.OTHER"))
          : item.title;

  const facts = correction
    ? [t(`entityRecord.corrections.status.${correction.status}`), item.who]
    : unlock
      ? [
          unlock.requester,
          reasonLabel("period_unlock", unlock.reason_code, unlock.reason_entry ?? undefined),
        ]
      : insurance
        ? [
            label(INSURER, insurance.insurer),
            codeText(`statutory.${insurance.kind}`, t("home.inbox.unknown")),
            fmtDate(insurance.effective_date),
          ]
        : lifecycle
          ? [label(LIFECYCLE_EVENT, lifecycle.action_kind), fmtDate(lifecycle.effective_date)]
          : [];

  const meta = [
    ...facts,
    item.context?.drafter ? t("home.decide.drafter", { name: item.context.drafter }) : undefined,
    item.site,
    item.ref && item.ref !== primary ? item.ref : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <WorklistSubject title={meta ? `${primary} · ${meta}` : primary}>
      <bdi className={`${s.subjectPrimary} t-ink t-medium`}>{primary}</bdi>
      {meta ? <bdi className={`${s.subjectMeta} t-faint t-xs`}>{meta}</bdi> : null}
    </WorklistSubject>
  );
}

export function ConsoleWorklistTable({
  items,
  selected,
  onSelect,
  checkedIds,
  onToggleCheck,
  onToggleAll,
  shownCols,
  action,
  inlineRowAction,
  extra,
  moreCount,
  morePending,
  onMore,
}: {
  items: readonly AttentionInboxItem[];
  selected?: string;
  onSelect?: (id: string) => void;
  checkedIds: ReadonlySet<string>;
  onToggleCheck: (id: string, next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  shownCols: ReadonlySet<OptionalWorklistColumn>;
  action?: RowAction;
  inlineRowAction?: (item: AttentionInboxItem, onSelectReject: () => void) => ReactNode;
  extra?: RowAction;
  moreCount?: number;
  morePending?: boolean;
  onMore?: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const folds = new Map<string, AttentionInboxItem[]>();
  for (const item of items) {
    const normalized = item.kind === "home_branch_review" ? { ...item, kind: "unplaced" } : item;
    const key = normalized.fold_key
      ? JSON.stringify([normalized.kind, normalized.fold_key, normalized.due ?? null])
      : normalized.id;
    const list = folds.get(key) ?? [];
    list.push(normalized);
    folds.set(key, list);
  }
  const topRows: AttentionInboxItem[] = [];
  const foldedMap = new Map<string, AttentionInboxItem[]>();
  for (const group of folds.values()) {
    const lead = group[0]!;
    topRows.push(lead);
    if (group.length > 1) foldedMap.set(lead.id, group);
  }
  const displayRows = topRows.flatMap(lead => {
    const group = foldedMap.get(lead.id);
    if (group && expanded.has(lead.id)) return group;
    return [lead];
  });

  const toggleFold = (id: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const allChecked = displayRows.length > 0 && displayRows.every(row => checkedIds.has(row.id));

  const columns: Column<AttentionInboxItem>[] = [
    {
      header: (
        <div role="presentation" onClick={e => e.stopPropagation()}>
          <Check
            aria-label={t("home.worklist.selectAll")}
            checked={allChecked}
            onChange={onToggleAll}
          />
        </div>
      ),
      fit: true,
      card: "omit",
      cell: item => {
        const taskLabel = t(
          item.context?.unlock?.exceptionId
            ? "periodLocks.review.title"
            : KIND_TEXT[item.kind] ?? "home.inbox.unknown",
        );
        return (
          <div role="presentation" onClick={e => e.stopPropagation()}>
            <Check
              aria-label={t("home.worklist.selectRow", { title: `${taskLabel} ${item.title}` })}
              checked={checkedIds.has(item.id)}
              onChange={next => onToggleCheck(item.id, next)}
            />
          </div>
        );
      },
    },
    {
      header: t("home.worklist.col.remaining"),
      fit: true,
      card: "status",
      cell: item => <DueCell days={item.days_remaining} />,
    },
  ];

  if (shownCols.has("date")) {
    columns.push({
      header: t("home.inbox.column.due"),
      fit: true,
      wide: true,
      cell: item => {
        const md = shortMonthDay(item.due);
        return md ? <bdi className={`${s.dateCol} muted num`}>{md}</bdi> : null;
      },
    });
  }

  columns.push(
    {
      header: t("home.worklist.col.task"),
      fit: true,
      card: "fact",
      cell: item => {
        const group = foldedMap.get(item.id);
        const isLeadFold = group?.[0]?.id === item.id && !expanded.has(item.id);
        const taskTitle = t(
          item.context?.unlock?.exceptionId
            ? "periodLocks.review.title"
            : KIND_TEXT[item.kind] ?? "home.inbox.unknown",
        );
        if (group && group[0]?.id === item.id) {
          const isOpen = expanded.has(item.id);
          return (
            <div className={s.taskCell} role="presentation" onClick={e => e.stopPropagation()}>
              <Button
                variant="ghost"
                size="sm"
                className={s.foldBtn}
                aria-expanded={isOpen}
                onClick={() => toggleFold(item.id)}
              >
                <ChevronRight size={14} aria-hidden="true" data-expanded={isOpen || undefined} />
                <strong>
                  {isLeadFold
                    ? t("home.inbox.foldCount", { kind: taskTitle, count: group.length })
                    : taskTitle}
                </strong>
              </Button>
            </div>
          );
        }
        return (
          <div className={s.taskCell}>
            <strong>{taskTitle}</strong>
          </div>
        );
      },
    },
    {
      header: t("home.worklist.col.subjectDetail"),
      card: "title",
      cell: item => <CompactSubject item={item} />,
    },
  );

  if (shownCols.has("reason")) {
    columns.push({
      header: t("home.inbox.record.reason"),
      wide: true,
      cell: item => {
        const lines = reasonLines(item);
        const text = lines.join(" · ");
        return lines.length > 0 ? <WorklistReason title={text}>{text}</WorklistReason> : null;
      },
    });
  }

  if (shownCols.has("statutory")) {
    columns.push({
      header: t("home.worklist.col.statutory"),
      fit: true,
      wide: true,
      cell: item =>
        isStatutoryDeadline(item) ? (
          <Chip tone="neutral">{t("home.worklist.statutoryBadge")}</Chip>
        ) : null,
    });
  }

  if (shownCols.has("action")) {
    columns.push({
      header: t("home.worklist.col.action"),
      fit: true,
      card: "action",
      cell: item => {
        const group = foldedMap.get(item.id);
        if (group && group[0]?.id === item.id && !expanded.has(item.id)) return null;
        const customInline = inlineRowAction?.(item, () => onSelect?.(item.id));
        const fallbackAction = customInline ?? recordAction(item, action);
        const snoozeControl = extra?.(item);
        if (!fallbackAction && !snoozeControl) return null;
        return (
          <div role="presentation" className={s.actionsCell} onClick={e => e.stopPropagation()}>
            {fallbackAction}
            {snoozeControl}
          </div>
        );
      },
    });
  }

  return (
    <div className={s.tableSection}>
      <Table
        label={t("home.inbox.title")}
        density="compact"
        rows={displayRows}
        rowId={row => row.id}
        selected={selected}
        onSelect={onSelect}
        tone={row => (row.dueTone === "danger" ? "danger" : undefined)}
        columns={columns}
      />
      {moreCount && moreCount > 0 && onMore ? (
        <WorklistMoreBar>
          <Button variant="ghost" size="sm" disabled={morePending} onClick={onMore}>
            <ChevronDown size={14} aria-hidden="true" />
            {t("home.worklist.moreCount", { count: moreCount })}
          </Button>
        </WorklistMoreBar>
      ) : null}
    </div>
  );
}

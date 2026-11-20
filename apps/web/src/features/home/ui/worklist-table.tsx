// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { Button, Check } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { DueCell } from "../../../ui/due-cell/due-cell";
import { WorklistMoreBar, WorklistReason } from "../../../ui/patterns/worklist-parts";
import { Table, type Column } from "../../../ui/table";
import type { AttentionInboxItem } from "../domain/inbox-filter";
import { isStatutoryDeadline, shortMonthDay, type OptionalWorklistColumn } from "../domain/inline-decide";
import { reasonLines, recordAction, taskTitleKey, type RowAction } from "./grouped-queue";

function consoleReasonText(item: AttentionInboxItem, taskLabel: string): string {
  const direct = item.context?.reason?.trim();
  if (
    direct &&
    !item.kind.startsWith("org_change") &&
    !item.context?.unlock?.exceptionId &&
    direct !== item.title &&
    direct !== taskLabel
  ) {
    return direct;
  }
  return reasonLines(item).join(" · ");
}
import s from "./worklist-console.module.css";
import { CompactSubject } from "./worklist-subject";

export function ConsoleWorklistTable({
  items,
  selected,
  onSelect,
  onOpen,
  checkedIds,
  onToggleCheck,
  onToggleIds,
  onToggleAll,
  shownCols,
  action,
  inlineRowAction,
  focusAfter,
  extra,
  moreCount,
  morePending,
  onMore,
}: {
  items: readonly AttentionInboxItem[];
  selected?: string;
  onSelect?: (id: string) => void;
  onOpen?: (id: string) => void;
  checkedIds: ReadonlySet<string>;
  onToggleCheck: (id: string, next: boolean) => void;
  onToggleIds?: (ids: readonly string[], next: boolean) => void;
  onToggleAll: (next: boolean) => void;
  shownCols: ReadonlySet<OptionalWorklistColumn>;
  action?: RowAction;
  inlineRowAction?: (item: AttentionInboxItem, onSelectReject: () => void) => ReactNode;
  focusAfter?: string;
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

  const isCollapsedFold = (item: AttentionInboxItem) => {
    const group = foldedMap.get(item.id);
    return Boolean(group && group[0]?.id === item.id && !expanded.has(item.id));
  };
  const rowKey = (item: AttentionInboxItem) => (isCollapsedFold(item) ? `fold:${item.id}` : item.id);
  const handleSelect = onSelect
    ? (id: string) => {
        if (id.startsWith("fold:")) toggleFold(id.slice(5));
        else onSelect(id);
      }
    : undefined;
  const handleOpen = onOpen
    ? (id: string) => {
        if (id.startsWith("fold:")) toggleFold(id.slice(5));
        else onOpen(id);
      }
    : undefined;

  const toggleGroup = (ids: readonly string[], next: boolean) => {
    if (onToggleIds) onToggleIds(ids, next);
    else for (const id of ids) onToggleCheck(id, next);
  };

  const allChecked = items.length > 0 && items.every(row => checkedIds.has(row.id));

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
        const group = isCollapsedFold(item) ? foldedMap.get(item.id)! : [item];
        const taskLabel = t(taskTitleKey(item));
        const rowLabel =
          group.length > 1
            ? t("home.inbox.foldCount", { kind: taskLabel, count: group.length })
            : `${taskLabel} ${item.title}`;
        return (
          <div role="presentation" onClick={e => e.stopPropagation()}>
            <Check
              aria-label={t("home.worklist.selectRow", { title: rowLabel })}
              checked={group.every(entry => checkedIds.has(entry.id))}
              onChange={next => toggleGroup(group.map(entry => entry.id), next)}
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
        const taskTitle = t(taskTitleKey(item));
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
        const text = consoleReasonText(item, t(taskTitleKey(item)));
        return text ? <WorklistReason title={text}>{text}</WorklistReason> : null;
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
        const suppressCommandFallback =
          item.links?.[0]?.kind === "org_change" &&
          item.context?.command === "approve" &&
          item.can_decide === false;
        const fallbackAction =
          customInline ?? recordAction(item, suppressCommandFallback ? undefined : action, undefined, focusAfter);
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
        rowId={rowKey}
        selected={selected}
        onSelect={handleSelect}
        onOpen={handleOpen}
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

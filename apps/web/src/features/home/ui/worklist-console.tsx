// SPDX-License-Identifier: LicenseRef-Proprietary
import { useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useRouterState, type AnyRouter } from "@tanstack/react-router";
import type { Checklist } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { liveApplying } from "../../../lib/live/live";
import { QueryState } from "../../../lib/react/query-state";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import { columnSelection } from "../../../lib/react/use-column-selection";
import type { AccessRequirement } from "../../../reference/authz/domain/access";
import { Button, Check } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { HeldNotice } from "../../../ui/live/held-notice";
import { Worklist } from "../../../ui/patterns/worklist";
import { WorklistMoreBar, WorklistSearchField, WorklistSegmentBar } from "../../../ui/patterns/worklist-parts";
import { SortControl } from "../../../ui/sort-control/sort-control";
import { isAttentionFilter, SNOOZED, type AttentionInboxItem, type AttentionInboxResponse, type InboxView } from "../domain/inbox-filter";
import { ALL_OPTIONAL_WORKLIST_COLUMNS, hasDistinctTaskLead, isStatutoryDeadline, sortWorklistItems, worklistItemHref, type OptionalWorklistColumn, type WorklistSortField } from "../domain/inline-decide";
import { reasonLines, taskTitleKey, type RowAction } from "./grouped-queue";
import { DoneList, ReferenceList } from "./inbox-finished";
import { UnavailableBanners } from "./inbox-queue";
import { InboxRecord } from "./inbox-record";
import { InboxTabs } from "./inbox-tabs";
import { QuietQueue } from "./quiet-queue";
import { SnoozeMenu, SnoozedList } from "./snooze";
import { isInboxRow, useInboxRead } from "./use-inbox-read";
import { useWorklistDecisionFocus } from "./use-worklist-decision-focus";
import { WorklistColumnsDialog } from "./worklist-columns-dialog";
import s from "./worklist-console.module.css";
import { WorklistLower } from "./worklist-lower";
import { WorklistSchedule } from "./worklist-schedule";
import { ConsoleWorklistTable } from "./worklist-table";

const HOME_CONSOLE_ROWS = 10;

export type WorklistConsoleProps = {
  mode: "home" | "inbox";
  title: ReactNode;
  titleId: string;
  baseline: () => ReactNode;
  view?: InboxView;
  meRead?: ReadState;
  setup?: (c: Checklist) => ReactNode;
  setupPhase?: boolean;
  setupPending?: boolean;
  receipt?: ReactNode;
  action?: RowAction;
  inlineRowAction?: (
    item: AttentionInboxItem,
    focusAfter: string,
    onSelectReject: () => void,
    onDecided?: () => void,
  ) => ReactNode;
  recordBody?: (item: AttentionInboxItem) => ReactNode;
  recordFooter?: (item: AttentionInboxItem, focusAfter: string, onDecided: () => void) => ReactNode;
  orgNeed?: AccessRequirement;
  canOrgStructure?: boolean;
};

/** Unified Worklist (`P1`) arrangement for `/` and `/inbox`, falling back to `baseline()` in Classic mode. */
export function WorklistConsole({
  mode, title, titleId, baseline, view = "turn", meRead, setup, setupPhase = false, setupPending = false,
  receipt, action, inlineRowAction, recordBody, recordFooter, orgNeed, canOrgStructure,
}: WorklistConsoleProps) {
  const isNonQueueView = mode === "inbox" && (view === "reference" || view === "done" || view === SNOOZED);
  const { inbox, attention, setAttention } = useInboxRead();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const search = useRouterState({ select: state => state.location.search as { sel?: string } });
  const navigate = useNavigate();
  const { sel, select } = columnSelection(search, options => navigate<AnyRouter, string>(options));

  const [foundSelection, setFoundSelection] = useState<string>();
  const [opened] = useState(Date.now);
  const [caughtUp, setCaughtUp] = useState(false);
  const [statutoryOnly, setStatutoryOnly] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [sort, setSort] = useState<{ field: WorklistSortField; direction: "asc" | "desc" }>({ field: "due", direction: "asc" });
  const [shownCols, setShownCols] = useState<Set<OptionalWorklistColumn>>(() => new Set(ALL_OPTIONAL_WORKLIST_COLUMNS));
  const [colsOpen, setColsOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [homeRowLimit, setHomeRowLimit] = useState(HOME_CONSOLE_ROWS);
  const [unfilteredCache, setUnfilteredCache] = useState<{ updatedAt: number; items: AttentionInboxItem[] }>();

  const applying = useSyncExternalStore(liveApplying.subscribe, liveApplying.get, liveApplying.get);
  const rereading = !caughtUp && inbox.isFetching && inbox.dataUpdatedAt < opened;
  if (!rereading && !inbox.isPending && !caughtUp) setCaughtUp(true);
  const mePending = mode === "inbox" && Boolean(meRead?.isPending);
  const meError = mode === "inbox" && meRead?.error ? meRead : undefined;
  const initialLoading = setupPending || rereading || mePending;
  const loading = initialLoading || applying;

  const pages = (inbox.data?.pages ?? []) as AttentionInboxResponse[];
  const first = pages[0];
  const checklist = first?.setup;
  const inSetup = setupPhase || Boolean(checklist);
  const allItems = pages
    .flatMap(page => page.items)
    .filter(item => isInboxRow(item.kind, Boolean(checklist)))
    .filter(item => !(mode === "inbox" && inSetup) || item.kind === "privacy_request");

  if (
    mode === "home" &&
    attention === "all" &&
    inbox.isSuccess &&
    !inbox.isPlaceholderData &&
    unfilteredCache?.updatedAt !== inbox.dataUpdatedAt
  ) {
    setUnfilteredCache({ updatedAt: inbox.dataUpdatedAt, items: allItems });
  }
  const unfilteredItems = mode === "home" && attention !== "all" && unfilteredCache ? unfilteredCache.items : allItems;

  const selectedItem = allItems.find(item => item.id === sel);
  if (selectedItem && foundSelection !== sel) setFoundSelection(sel);
  else if (foundSelection && foundSelection !== sel) setFoundSelection(undefined);
  const removed = Boolean(sel) && foundSelection === sel && inbox.isSuccess && !inbox.isPlaceholderData && !selectedItem;

  const normalizedQuery = findQuery.trim().toLowerCase();
  const hasClientFilter = Boolean(normalizedQuery || statutoryOnly);
  const filteredItems = allItems.filter(item => {
    if (statutoryOnly && !isStatutoryDeadline(item)) return false;
    if (!normalizedQuery) return true;
    const taskTitle = t(taskTitleKey(item));
    return [taskTitle, item.title, item.ref, item.site, item.who, ...reasonLines(item)].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
  });
  const sortedItems = sortWorklistItems(filteredItems, sort.field, sort.direction, item =>
    hasDistinctTaskLead(item) ? item.title.trim() : t(taskTitleKey(item)),
  );
  const visibleRows = mode === "home" ? sortedItems.slice(0, homeRowLimit) : sortedItems;
  const { onItemDecided } = useWorklistDecisionFocus({
    surfaceRef,
    visibleRows,
    selectedItem,
    sel,
    select,
    removed,
    dataUpdatedAt: inbox.dataUpdatedAt,
    isFetching: inbox.isFetching,
    titleId,
  });

  if (isNonQueueView) {
    return (
      <Worklist
        q={meError ? meError : loading ? { ...(meRead ?? inbox), isPending: true, data: undefined } : (meRead ?? inbox)}
        baseline={baseline}
        head={{
          title, titleId,
          meta: !loading && !meError && !inSetup && !inbox.isPending && !inbox.error && first?.as_of
            ? <time className="muted t-sm" dateTime={first.as_of}>{t("home.asOf", { time: fmtDateTime(first.as_of) })}</time>
            : undefined,
        }}
        stats={!loading && !meError && !inSetup && !inbox.isPending && !inbox.error ? <InboxTabs view={view} /> : undefined}
        list={() => (view === "reference" ? <ReferenceList /> : view === "done" ? <DoneList /> : <SnoozedList />)}
      />
    );
  }
  const visibleIdSet = new Set(visibleRows.map(row => row.id));
  const activeCheckedIds = new Set([...checkedIds].filter(id => visibleIdSet.has(id)));
  const remainingCount = mode === "home"
    ? Math.max(0, (hasClientFilter ? sortedItems.length : Math.max(first?.total ?? sortedItems.length, sortedItems.length)) - visibleRows.length)
    : inbox.hasNextPage ? Math.max(1, (first?.total ?? sortedItems.length) - sortedItems.length) : 0;

  const columnsEnabled = !inSetup;
  const recordVisible = !loading && !meError && inbox.data !== undefined && ["ready", "stale", "offline"].includes(queryView(inbox));
  const showControls = !initialLoading && !inSetup && !meError && !inbox.error && Boolean(first?.has_work || first?.available_filters.length);
  // Home's only way to the other lanes, the done list and rows it does not load: a steady way in once home has settled,
  // whatever the list holds.
  const inboxLink = mode === "home" && !loading && !inSetup && !meError && !inbox.error ? <Link to="/inbox">{t("home.inbox.viewInbox")}</Link> : undefined;
  const selectItem = (id: string) => { if (allItems.some(item => item.id === id)) select(id); };
  const focusRecord = () =>
    surfaceRef.current
      ?.closest("[data-pane-grid]")
      ?.querySelector<HTMLElement>('aside[data-pane="record"] h2[tabindex]')
      ?.focus();
  const snooze: RowAction = item => item.snooze?.allowed ? <SnoozeMenu item={item} presets={first?.snooze_presets ?? []} asOf={first?.as_of} /> : null;
  const unavailable = [...new Map(pages.flatMap(page => page.unavailable).map(part => [part.source, part])).values()];
  const isInlineApproval =
    selectedItem !== undefined &&
    ((selectedItem.links?.[0]?.kind === "org_change" && selectedItem.context?.command === "approve") ||
      (selectedItem.kind === "approval" && selectedItem.links?.[0]?.kind === "approval_run"));
  const openHref = selectedItem ? worklistItemHref(selectedItem) : null;
  const scheduleItems = mode === "home" ? sortWorklistItems(unfilteredItems, "due", "asc").slice(0, homeRowLimit) : unfilteredItems;
  const checkedRows = visibleRows.filter(row => activeCheckedIds.has(row.id));
  const statusSelectedItem =
    checkedRows.length === 1
      ? checkedRows[0]
      : checkedRows.length > 1
        ? (selectedItem && activeCheckedIds.has(selectedItem.id) ? selectedItem : checkedRows[0])
        : selectedItem;
  const statusSelectedCount = checkedRows.length > 0 ? checkedRows.length : selectedItem ? 1 : 0;

  return (
    <Worklist
      q={meError ? meError : initialLoading ? { ...inbox, isPending: true, data: undefined } : inbox}
      baseline={baseline}
      head={{
        title, titleId,
        meta: mode === "inbox" && !loading && !inSetup && !meError && !inbox.error && first?.as_of
          ? <time className="muted t-sm" dateTime={first.as_of}>{t("home.asOf", { time: fmtDateTime(first.as_of) })}</time>
          : undefined,
      }}
      stats={mode === "inbox" && !initialLoading && !meError && !inSetup && !inbox.isPending && !inbox.error ? <InboxTabs view={view} /> : undefined}
      views={showControls && mode === "home" && first?.attention_filters?.length ? (
        <WorklistSegmentBar
          label={t("home.attention.label")}
          value={attention}
          onChange={setAttention}
          items={first.attention_filters.filter(({ key }) => isAttentionFilter(key)).map(({ key, total, total_is_exact }) => ({
            id: key, label: t(`home.attention.${key}`), count: `${fmtNumber(total)}${total_is_exact ? "" : "+"}`,
            tone: key === "overdue" ? ("danger" as const) : undefined,
            icon: key === "overdue" ? <AlertTriangle size={12} aria-hidden="true" /> : undefined,
          }))}
        />
      ) : undefined}
      filters={showControls ? <Check checked={statutoryOnly} onChange={setStatutoryOnly}>{t("home.worklist.statutoryOnly")}</Check> : undefined}
      find={showControls ? <div data-list-find=""><WorklistSearchField label={t("home.worklist.find")} value={findQuery} onChange={setFindQuery} /></div> : undefined}
      tools={showControls ? (
        <div className={s.toolsRow}>
          <SortControl fields={[{ id: "due", label: t("home.inbox.column.due") }, { id: "task", label: t("home.worklist.col.task") }]} field={sort.field} direction={sort.direction} onChange={setSort} />
          <Button size="sm" onClick={() => setColsOpen(true)}><SlidersHorizontal size={13} aria-hidden="true" />{t("home.worklist.columns")}</Button>
        </div>
      ) : undefined}
      notes={receipt}
      recovery={receipt}
      list={() => {
        const noWork = !first?.has_work && unavailable.length === 0;
        if (mode === "inbox" && inSetup && !allItems.length && !unavailable.length && !inbox.hasNextPage) {
          return <EmptyState title={t("home.inbox.setup.title")} reason={null} actions={<Link to="/" className={buttonClass("primary")}>{t("shell.link.todo")}</Link>} />;
        }
        return (
          <div ref={surfaceRef} className={s.tableWrap}>
            {showControls && <HeldNotice placement="list" align="start" />}
            <QueryState q={applying ? { ...inbox, isPending: true, data: undefined } : inbox} layout="list">{() => <>
            <UnavailableBanners unavailable={unavailable} onRetry={() => void inbox.refetch()} retrying={inbox.isFetching} />
            {checklist && setup?.(checklist)}
            {!checklist && noWork && (
              <EmptyState
                title={t("home.noWork.title")}
                reason={t("home.noWork.reason")}
                actions={visibleRows.some(item => item.kind === "account_security") ? undefined : <Link to="/account" className={buttonClass("primary")}>{t("shell.account")}</Link>}
              />
            )}
            {visibleRows.length > 0 ? (
              <ConsoleWorklistTable
                items={visibleRows}
                selected={columnsEnabled ? sel : undefined}
                onSelect={columnsEnabled ? selectItem : undefined}
                onOpen={columnsEnabled ? focusRecord : undefined}
                checkedIds={activeCheckedIds}
                onToggleCheck={(id, next) => setCheckedIds(prev => { const updated = new Set(prev); if (next) updated.add(id); else updated.delete(id); return updated; })}
                onToggleIds={(ids, next) => setCheckedIds(prev => { const updated = new Set(prev); for (const id of ids) { if (next) updated.add(id); else updated.delete(id); } return updated; })}
                onToggleAll={next => setCheckedIds(next ? new Set(visibleRows.map(row => row.id)) : new Set())}
                shownCols={shownCols}
                action={action}
                inlineRowAction={inlineRowAction ? (item, onSelectReject) => inlineRowAction(item, titleId, onSelectReject, () => onItemDecided(item.id)) : undefined}
                focusAfter={titleId}
                moreCount={remainingCount}
                moreLabel={mode === "inbox" ? t("home.inbox.more") : undefined}
                moreLink={inboxLink}
                morePending={inbox.isFetchingNextPage}
                onMore={() => {
                  if (mode === "home") {
                    if (sortedItems.length > homeRowLimit) setHomeRowLimit(prev => prev + HOME_CONSOLE_ROWS);
                    else if (inbox.hasNextPage) { setHomeRowLimit(prev => prev + HOME_CONSOLE_ROWS); void inbox.fetchNextPage(); }
                    else void navigate({ to: "/inbox" });
                  } else void inbox.fetchNextPage();
                }}
              />
            ) : allItems.length > 0 && hasClientFilter ? (
              <EmptyState
                title={t("home.worklist.noMatch.title")}
                reason={t("home.worklist.noMatch.reason")}
                actions={<Button onClick={() => { setFindQuery(""); setStatutoryOnly(false); }}>{t("home.worklist.noMatch.reset")}</Button>}
              />
            ) : !checklist && !noWork && first && <QuietQueue page={first} filter={mode === "home" && attention !== "all" ? attention : view} partial={unavailable.length > 0} />}
            {visibleRows.length === 0 && inboxLink && <WorklistMoreBar>{inboxLink}</WorklistMoreBar>}
            </>}</QueryState>
          </div>
        );
      }}
      schedule={!loading && !meError && !inbox.error && !inSetup && scheduleItems.length > 0 ? () => <WorklistSchedule items={scheduleItems} asOf={first?.as_of} selectedId={columnsEnabled ? sel : undefined} onSelect={columnsEnabled ? selectItem : undefined} /> : undefined}
      bands={!loading && !meError && !inbox.error && !inSetup && first?.has_work ? () => <WorklistLower items={unfilteredItems} asOf={first?.as_of} action={action} focusAfter={titleId} orgNeed={orgNeed} canOrgStructure={canOrgStructure} /> : undefined}
      onSelect={columnsEnabled ? selectItem : undefined}
      onOpen={columnsEnabled ? focusRecord : undefined}
      record={columnsEnabled && recordVisible && !removed && sel ? {
        id: sel,
        label: t("home.inbox.record.title"),
        title: selectedItem ? [t("home.worklist.selectedMeta"), selectedItem.title, selectedItem.ref].filter(Boolean).join(" · ") : t("home.worklist.selectedMeta"),
        openInTab: openHref && selectedItem ? { href: openHref, label: selectedItem.title } : undefined,
        onClose: () => select(undefined),
        returnFocus: () => surfaceRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(sel)}"]`),
        footer: isInlineApproval && selectedItem && recordFooter
          ? recordFooter(selectedItem, titleId, () => onItemDecided(selectedItem.id))
          : undefined,
        children: isInlineApproval && selectedItem && recordBody ? recordBody(selectedItem) : <InboxRecord item={selectedItem} action={action} extra={snooze} focusAfter={titleId} onBack={() => select(undefined)} />,
      } : null}
      statusSegments={!loading && !meError && !inbox.error && first && !inSetup ? [
        { id: "total", content: t("home.worklist.statusTotal", { count: first.total }) },
        { id: "shown", content: t("home.worklist.statusShown", { count: visibleRows.length }) },
        ...(statusSelectedItem && statusSelectedCount > 0 ? [{ id: "selected", tone: "strong" as const, content: t("home.worklist.statusSelected", { count: statusSelectedCount, title: statusSelectedItem.ref ? `${statusSelectedItem.title} ${statusSelectedItem.ref}` : statusSelectedItem.title }) }] : []),
      ] : null}
      overlays={
        <WorklistColumnsDialog
          open={colsOpen}
          shownCols={shownCols}
          onToggle={(col, next) => setShownCols(prev => { const updated = new Set(prev); if (next) updated.add(col); else updated.delete(col); return updated; })}
          onClose={() => setColsOpen(false)}
        />
      }
    />
  );
}

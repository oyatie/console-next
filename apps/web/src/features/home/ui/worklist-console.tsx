// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Link, useNavigate, useRouterState, type AnyRouter } from "@tanstack/react-router";
import type { Checklist } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { AlertTriangle, SlidersHorizontal } from "lucide-react";
import { liveApplying } from "../../../lib/live/live";
import { queryView, type ReadState } from "../../../lib/react/query-view";
import { columnSelection } from "../../../lib/react/use-column-selection";
import type { AccessRequirement } from "../../../reference/authz/domain/access";
import { Button, Check } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { EmptyState } from "../../../ui/empty-state";
import { HeldNotice } from "../../../ui/live/held-notice";
import { Worklist } from "../../../ui/patterns/worklist";
import { WorklistSearchField, WorklistSegmentBar } from "../../../ui/patterns/worklist-parts";
import { SortControl } from "../../../ui/sort-control/sort-control";
import { isAttentionFilter, SNOOZED, type AttentionInboxItem, type AttentionInboxResponse, type InboxView } from "../domain/inbox-filter";
import { ALL_OPTIONAL_WORKLIST_COLUMNS, isStatutoryDeadline, sortWorklistItems, worklistItemHref, type OptionalWorklistColumn, type WorklistSortField } from "../domain/inline-decide";
import { KIND_TEXT, reasonLines, type RowAction } from "./grouped-queue";
import { DoneList, ReferenceList } from "./inbox-finished";
import { UnavailableBanners } from "./inbox-queue";
import { InboxRecord } from "./inbox-record";
import { InboxTabs } from "./inbox-tabs";
import { QuietQueue } from "./quiet-queue";
import { SnoozeMenu, SnoozedList } from "./snooze";
import { useInboxRead } from "./use-inbox-read";
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
  inlineRowAction?: (item: AttentionInboxItem, focusAfter: string, onSelectReject: () => void) => ReactNode;
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
  const restoreList = useRef(false);
  const [opened] = useState(Date.now);
  const [caughtUp, setCaughtUp] = useState(false);
  const [statutoryOnly, setStatutoryOnly] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [sort, setSort] = useState<{ field: WorklistSortField; direction: "asc" | "desc" }>({ field: "due", direction: "asc" });
  const [shownCols, setShownCols] = useState<Set<OptionalWorklistColumn>>(() => new Set(ALL_OPTIONAL_WORKLIST_COLUMNS));
  const [colsOpen, setColsOpen] = useState(false);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(() => new Set());
  const [homeRowLimit, setHomeRowLimit] = useState(HOME_CONSOLE_ROWS);

  const applying = useSyncExternalStore(liveApplying.subscribe, liveApplying.get, liveApplying.get);
  const rereading = !caughtUp && inbox.isFetching && inbox.dataUpdatedAt < opened;
  if (!rereading && !inbox.isPending && !caughtUp) setCaughtUp(true);
  const loading = setupPending || rereading || applying;

  const pages = (inbox.data?.pages ?? []) as AttentionInboxResponse[];
  const first = pages[0];
  const checklist = first?.setup;
  const inSetup = setupPhase || Boolean(checklist);
  const allItems = (mode === "home" ? pages.slice(0, 1) : pages)
    .flatMap(page => page.items)
    .filter(item => !checklist || !item.kind.startsWith("setup_"))
    .filter(item => !(mode === "inbox" && inSetup) || item.kind === "privacy_request");

  const selectedItem = allItems.find(item => item.id === sel);
  if (selectedItem && foundSelection !== sel) setFoundSelection(sel);
  else if (foundSelection && foundSelection !== sel) setFoundSelection(undefined);
  const removed = Boolean(sel) && foundSelection === sel && inbox.isSuccess && !inbox.isPlaceholderData && !selectedItem;

  useEffect(() => {
    if (removed) {
      restoreList.current = true;
      select(undefined);
    } else if (!sel && restoreList.current) {
      let nextFrame = 0;
      const frame = requestAnimationFrame(() => {
        nextFrame = requestAnimationFrame(() => {
          restoreList.current = false;
          surfaceRef.current?.querySelector<HTMLElement>("[data-id], a[href], button")?.focus();
        });
      });
      return () => { cancelAnimationFrame(frame); cancelAnimationFrame(nextFrame); };
    }
  }, [removed, sel, select]);

  if (isNonQueueView) {
    return (
      <Worklist
        q={meRead ?? inbox}
        baseline={baseline}
        head={{
          title, titleId,
          asOf: !inSetup && !inbox.error && first?.as_of ? <time className="muted t-sm" dateTime={first.as_of}>{t("home.asOf", { time: fmtDateTime(first.as_of) })}</time> : undefined,
        }}
        tabs={<InboxTabs view={view} />}
        list={() => (view === "reference" ? <ReferenceList /> : view === "done" ? <DoneList /> : <SnoozedList />)}
      />
    );
  }

  const normalizedQuery = findQuery.trim().toLowerCase();
  const filteredItems = allItems.filter(item => {
    if (statutoryOnly && !isStatutoryDeadline(item)) return false;
    if (!normalizedQuery) return true;
    const taskTitle = t(item.context?.unlock?.exceptionId ? "periodLocks.review.title" : KIND_TEXT[item.kind] ?? "home.inbox.unknown");
    return [taskTitle, item.title, item.ref, item.site, item.who, ...reasonLines(item)].filter(Boolean).join(" ").toLowerCase().includes(normalizedQuery);
  });
  const sortedItems = sortWorklistItems(filteredItems, sort.field, sort.direction);
  const visibleRows = mode === "home" ? sortedItems.slice(0, homeRowLimit) : sortedItems;
  const remainingCount = mode === "home"
    ? Math.max(0, (normalizedQuery || statutoryOnly ? sortedItems.length : Math.max(first?.total ?? sortedItems.length, sortedItems.length)) - visibleRows.length)
    : inbox.hasNextPage ? Math.max(1, (first?.total ?? sortedItems.length) - sortedItems.length) : 0;

  const columnsEnabled = !inSetup;
  const recordVisible = !loading && inbox.data !== undefined && ["ready", "stale", "offline"].includes(queryView(inbox));
  const showControls = !inSetup && Boolean(first?.has_work || first?.available_filters.length);
  const selectItem = (id: string) => { if (allItems.some(item => item.id === id)) select(id); };
  const focusRecord = () => surfaceRef.current?.querySelector<HTMLElement>("aside h2[tabindex]")?.focus();
  const snooze: RowAction = item => item.snooze?.allowed ? <SnoozeMenu item={item} presets={first?.snooze_presets ?? []} asOf={first?.as_of} /> : null;
  const unavailable = [...new Map(pages.flatMap(page => page.unavailable).map(part => [part.source, part])).values()];
  const isInlineApproval = selectedItem?.links[0]?.kind === "org_change" && selectedItem.context?.command === "approve";
  const openHref = selectedItem ? worklistItemHref(selectedItem) : null;

  return (
    <Worklist
      q={loading ? { ...inbox, isPending: true, data: undefined } : inbox}
      baseline={baseline}
      head={{
        title, titleId,
        asOf: mode === "inbox" && !inSetup && !inbox.error && first?.as_of
          ? <time className="muted t-sm" dateTime={first.as_of}>{t("home.asOf", { time: fmtDateTime(first.as_of) })}</time>
          : undefined,
        actions: mode === "home" && showControls && !loading && !inbox.error
          ? <Link to="/inbox" className={buttonClass("ghost", { size: "sm" })}>{t("home.inbox.viewInbox")}</Link>
          : undefined,
      }}
      tabs={mode === "inbox" && !inSetup ? <InboxTabs view={view} /> : undefined}
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
      notes={<>{receipt}<HeldNotice placement="list" /></>}
      list={() => {
        const noWork = !first?.has_work && unavailable.length === 0;
        if (mode === "inbox" && inSetup && !allItems.length && !unavailable.length && !inbox.hasNextPage) {
          return <EmptyState title={t("home.inbox.setup.title")} reason={null} actions={<Link to="/" className={buttonClass("primary")}>{t("shell.link.home")}</Link>} />;
        }
        return (
          <div ref={surfaceRef} className={s.tableWrap}>
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
                checkedIds={checkedIds}
                onToggleCheck={(id, next) => setCheckedIds(prev => { const updated = new Set(prev); if (next) updated.add(id); else updated.delete(id); return updated; })}
                onToggleAll={next => setCheckedIds(next ? new Set(visibleRows.map(row => row.id)) : new Set())}
                shownCols={shownCols}
                action={action}
                inlineRowAction={inlineRowAction ? (item, onSelectReject) => inlineRowAction(item, titleId, onSelectReject) : undefined}
                extra={snooze}
                moreCount={remainingCount}
                morePending={inbox.isFetchingNextPage}
                onMore={() => {
                  if (mode === "home") {
                    if (sortedItems.length > homeRowLimit) setHomeRowLimit(prev => prev + HOME_CONSOLE_ROWS);
                    else if (inbox.hasNextPage) { setHomeRowLimit(prev => prev + HOME_CONSOLE_ROWS); void inbox.fetchNextPage(); }
                    else void navigate({ to: "/inbox" });
                  } else void inbox.fetchNextPage();
                }}
              />
            ) : !checklist && !noWork && first && <QuietQueue page={first} filter={mode === "home" && attention !== "all" ? attention : view} partial={unavailable.length > 0} />}
          </div>
        );
      }}
      schedule={!loading && !inbox.error && !inSetup && visibleRows.length > 0 ? () => <WorklistSchedule items={visibleRows} asOf={first?.as_of} selectedId={columnsEnabled ? sel : undefined} onSelect={columnsEnabled ? selectItem : undefined} /> : undefined}
      bands={!loading && !inbox.error && !inSetup && first?.has_work ? () => <WorklistLower items={allItems} asOf={first?.as_of} action={action} orgNeed={orgNeed} canOrgStructure={canOrgStructure} /> : undefined}
      onSelect={columnsEnabled ? selectItem : undefined}
      onOpen={columnsEnabled ? focusRecord : undefined}
      record={columnsEnabled && recordVisible && !removed && sel && selectedItem ? {
        id: sel,
        label: t("home.inbox.record.title"),
        title: selectedItem.ref ? `${t("home.worklist.selectedMeta")} · ${selectedItem.ref}` : t("home.worklist.selectedMeta"),
        openInTab: openHref ? { href: openHref, label: selectedItem.title } : undefined,
        onClose: () => select(undefined),
        returnFocus: () => surfaceRef.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(sel)}"]`),
        footer: isInlineApproval && recordFooter ? recordFooter(selectedItem, titleId, () => select(undefined)) : undefined,
        children: isInlineApproval && recordBody ? recordBody(selectedItem) : <InboxRecord item={selectedItem} action={action} extra={snooze} onBack={() => select(undefined)} />,
      } : null}
      statusSegments={!loading && !inbox.error && first && !inSetup ? [
        { id: "total", content: t("home.worklist.statusTotal", { count: first.total }) },
        { id: "shown", content: t("home.worklist.statusShown", { count: visibleRows.length }) },
        ...(selectedItem ? [{ id: "selected", tone: "strong" as const, content: t("home.worklist.statusSelected", { count: 1, title: selectedItem.ref ? `${selectedItem.title} ${selectedItem.ref}` : selectedItem.title }) }] : []),
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

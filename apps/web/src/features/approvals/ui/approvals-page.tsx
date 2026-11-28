// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtNumber } from "@console/i18n/format";
import { SEARCH_DEBOUNCE_MS } from "../../../lib/freshness";
import { readIdentity } from "../../../lib/query";
import { APPROVAL_SUBMISSION_MODULE, moduleReady, modulesQuery } from "../../../reference/onboarding/api";
import { useMarkActiveCachedQuery } from "../../../lib/react/cached-pages";
import { QueryState } from "../../../lib/react/query-state";
import { columnSelection } from "../../../lib/react/use-column-selection";
import { Button } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { FlexibleColumns } from "../../../ui/flexible-columns/flexible-columns";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { ExperienceSwitch } from "../../../ui/patterns/experience-switch";
import { Worklist } from "../../../ui/patterns/worklist";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import { SearchField } from "../../../ui/search/search-field";
import { SelectField } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { approvalDocumentQuery, approvalPages, type ApprovalItem } from "../api";
import { APPROVAL_BOXES, type ApprovalBox } from "../domain/inbox";
import { ApprovalDecisionPanel, ApprovalDocumentView } from "./approval-viewer";
import { ConsoleApprovalSideView, ConsoleApprovalsTable } from "./approvals-console";
import { SourceViewerLink } from "./source-viewer-link";
import { useDecisionOffered } from "./use-approval-decision";
import { useApprovalsDesktop } from "./use-approvals-desktop";
import s from "./approvals-page.module.css";

const route = getRouteApi("/app/approvals");
const ALL_SOURCES = "all";
const CLOSED = { sel: undefined, full: undefined };

/** The list stays left; `record` is the selected document, shown beside it (one column with a back button at phone width). */
export function ApprovalInboxView({ items, sel, selected, record, onSelect, onClose, onFind, full, onFull, hasNext, loadingMore, onMore, emptyTitle }: {
  items: ApprovalItem[];
  sel?: string;
  /** The document for `sel`, or its list row until the document arrives: it titles the column. */
  selected?: ApprovalItem;
  record?: ReactNode;
  onSelect: (id: string) => void;
  onClose: () => void;
  onFind?: () => void;
  full?: boolean;
  onFull?: (on: boolean) => void;
  hasNext?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  emptyTitle?: string;
}) {
  const rows = useRef<HTMLDivElement>(null);
  const list = <Card label={t("approvals.list")} flush>
    {items.length ? <div ref={rows} className={s.list}>
      <Table label={t("approvals.list")} rows={items} rowId={item => item.id} selected={sel} onSelect={onSelect} columns={[
        { header: t("approvals.field.documentNo"), card: "fact", fit: true, cell: item => <code className={s.secondary} title={item.document_no ?? "—"}>{item.document_no ?? "—"}</code> },
        // The date the document takes effect reads with its title, so a row says what it is and when it applies.
        { header: t("approvals.col.title"), card: "title", cell: item => {
          const effective = item.effective_date ? ` · ${t("approvals.row.effective", { date: fmtDate(item.effective_date) })}` : "";
          return <span className={s.title} title={`${item.title}${effective}`}>{item.title}{effective && <time dateTime={item.effective_date!}>{effective}</time>}</span>;
        } },
        { header: t("approvals.col.source"), card: "fact", fit: true, cell: item => <div className={s.secondary} title={item.source.label}>{item.source.label}</div> },
        { header: t("approvals.preview.route"), card: "fact", fit: true, cell: item => item.route.length
          // Only the current step names its role; the others show who signs, so the whole approval line fits one row.
          ? <div className={`${s.secondary} ${s.route}`}><ChainStepper variant="chips" label={t("approvals.preview.route")} steps={item.route.map(step => ({ key: step.id, state: step.state, who: step.state === "current" ? [step.label, step.assignee].filter(Boolean).join(" · ") : step.assignee ?? step.label }))} /></div>
          : <div className={s.secondary}>—</div> },
        { header: t("approvals.col.requester"), card: "fact", fit: true, cell: item => {
          const name = item.requester?.name ?? "—";
          return <div className={s.secondary} title={name}>{name}</div>;
        } },
        { header: t("approvals.col.requestedAt"), card: "fact", fit: true, cell: item => <time className={`${s.secondary} num`} title={fmtDateTime(item.requested_at)} dateTime={item.requested_at}>{fmtDateTime(item.requested_at)}</time> },
        { header: t("approvals.col.status"), card: "status", fit: true, cell: item => <Chip tone={item.status.tone}>{item.status.label}</Chip> },
      ]} />
      {hasNext && <div className={s.more}><Button disabled={loadingMore} onClick={onMore}>{t("approvals.more")}</Button></div>}
    </div> : <EmptyState title={emptyTitle ?? t("approvals.empty.title")} reason={t("approvals.empty.reason")} />}
  </Card>;
  return <FlexibleColumns list={list} onSelect={onSelect} onFind={onFind} full={full} onFull={onFull} record={sel && {
    id: sel, label: t("approvals.document.title"), title: selected?.title ?? t("approvals.document.title"), crumb: selected?.document_no,
    expand: <SourceViewerLink viewer={selected?.viewer} />, onClose,
    returnFocus: () => {
      // A decided document leaves the pending list: focus then goes to the first row left, or to the find box of an empty list.
      const row = document.querySelector<HTMLElement>(`[data-id="${CSS.escape(sel)}"]`) ?? rows.current?.querySelector<HTMLElement>("[data-id]");
      if (!row) onFind?.();
      return row;
    },
    children: <>
      {selected && <div className={s.meta}><Chip>{selected.source.label}</Chip><Chip tone={selected.status.tone}>{selected.status.label}</Chip></div>}
      {record}
    </>,
  }} />;
}

function useApprovalsSearch() {
  const search = route.useSearch();
  const box: ApprovalBox = search.box ?? "pending";
  const { q: urlQuery = "", source } = search;
  const navigate = route.useNavigate();
  const selection = columnSelection(search, navigate);
  const filters = useRef<HTMLDivElement>(null);
  const set = useCallback((patch: { box?: Exclude<ApprovalBox, "pending">; q?: string; source?: string; sel?: string; full?: 1 }) => void navigate({ search: previous => ({ ...previous, ...patch }), replace: true, resetScroll: false }), [navigate]);
  const [query, setQuery] = useState(urlQuery);
  const pushed = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery !== pushed.current) { pushed.current = urlQuery; setQuery(urlQuery); }
  }, [urlQuery]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query === pushed.current) return;
      pushed.current = query;
      set({ q: query.trim() || undefined, ...CLOSED });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, set]);
  const inboxQuery = approvalPages({ box, q: urlQuery || undefined, source });
  const inbox = useInfiniteQuery({ ...inboxQuery, placeholderData: keepPreviousData, refetchOnMount: "always" });
  useMarkActiveCachedQuery(readIdentity(inboxQuery), Boolean(inbox.data) && !inbox.isPlaceholderData);
  const pages = inbox.data?.pages;
  const first = pages?.[0];
  const items = pages?.flatMap(page => page.items) ?? [];
  const tabs = <TabNav label={t("approvals.tabs")} overflow="scroll">{APPROVAL_BOXES.map(id => <Link
    key={id} to="/approvals" search={{ box: id === "pending" ? undefined : id, q: urlQuery || undefined, source }}
    className={tabClass} aria-current={box === id ? "page" : undefined} resetScroll={false}
  >{t(`approvals.box.${id}`)}<TabCount>{first?.counts[id]}</TabCount></Link>)}</TabNav>;
  const sourceOptions = [{ id: ALL_SOURCES, label: t("approvals.filters.allSources") }, ...(first?.sources ?? []).map(item => ({ id: item.key, label: t("approvals.source.count", { label: item.label, count: item.count }) }))];
  return { box, urlQuery, source, selection, filters, set, query, setQuery, inbox, first, items, tabs, sourceOptions };
}

function NewApprovalLink() {
  const modules = useQuery(modulesQuery);
  return moduleReady(modules.data, APPROVAL_SUBMISSION_MODULE) ? <Link to="/approvals/new" className={buttonClass("primary", { size: "sm" })}>{t("approvals.new.cta")}</Link> : null;
}

function BaselineApprovalsPage() {
  const { box, urlQuery, source, selection: { sel, full, expand, restore, select }, filters, set, query, setQuery, inbox, items, tabs, sourceOptions } = useApprovalsSearch();
  const opened = useQuery({ ...approvalDocumentQuery(sel ?? ""), enabled: Boolean(sel), refetchOnMount: "always" });
  const selected = (opened.data?.id === sel ? opened.data : undefined) ?? items.find(item => item.id === sel);
  const filtered = Boolean(urlQuery || source);
  const reset = () => { setQuery(""); set({ q: undefined, source: undefined, ...CLOSED }); };
  return (
    <Page floorplan="P-03" head={{ title: t("approvals.title"), tabs, actions: <NewApprovalLink /> }} toolbar={<div ref={filters} className={s.filters} role="group" aria-label={t("approvals.filters.label")}>
      <SearchField label={t("approvals.filters.search")} value={query} onChange={setQuery} />
      <SelectField hideLabel label={t("approvals.filters.source")} placeholder={t("approvals.filters.allSources")} options={sourceOptions} value={source ?? ALL_SOURCES} onChange={id => set({ source: id === ALL_SOURCES ? undefined : id, ...CLOSED })} />
      {filtered && <Button variant="ghost" onClick={reset}>{t("approvals.filters.reset")}</Button>}
    </div>}>
      <QueryState q={inbox} layout="list">{() => <ApprovalInboxView
        items={items} sel={sel} selected={selected ?? undefined} record={sel && <QueryState key={sel} q={opened} layout="record">{document => <ApprovalDocumentView document={document} />}</QueryState>}
        onSelect={select} onClose={() => select(undefined)} onFind={() => filters.current?.querySelector("input")?.focus()}
        full={full} onFull={on => on ? expand() : restore()}
        hasNext={inbox.hasNextPage} loadingMore={inbox.isFetchingNextPage} onMore={() => void inbox.fetchNextPage()}
        emptyTitle={t(`approvals.empty.${box}`)}
      />}</QueryState>
    </Page>
  );
}

function ConsoleApprovalsPage() {
  const { box, urlQuery, source, selection: { sel, full, expand, restore, select }, filters, set, query, setQuery, inbox, first, items, tabs, sourceOptions } = useApprovalsSearch();
  const isDesktop = useApprovalsDesktop();
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [blockedKey, setBlockedKey] = useState<string | null>(null);
  const [receiptState, setReceiptState] = useState<{ id: string; text: string }>();
  const rows = useRef<HTMLDivElement>(null);
  const findBox = useRef<HTMLDivElement>(null);
  const baseFilterKey = `${box}|${urlQuery}|${source ?? ""}`;
  const blockedOnly = blockedKey === baseFilterKey;
  const visibleItems = blockedOnly ? items.filter(item => Boolean(item.decision_refusal)) : items;
  const filterKey = `${baseFilterKey}|${blockedOnly ? "1" : "0"}`;
  const effectiveSel = sel ?? (isDesktop && dismissedKey !== filterKey ? visibleItems[0]?.id : undefined);
  // The document is read by its id, so selecting never re-reads the list and a shared or reloaded link needs no list row.
  const opened = useQuery({ ...approvalDocumentQuery(effectiveSel ?? ""), enabled: Boolean(effectiveSel), refetchOnMount: "always" });
  const openedDoc = opened.data?.id === effectiveSel ? opened.data : undefined;
  const selected = openedDoc ?? visibleItems.find(item => item.id === effectiveSel) ?? items.find(item => item.id === effectiveSel);
  // The footer stays through the command, and to say so when a later read withdraws the decision; opening another
  // document ends that. The receipt of the last decision made here is drawn again when its document is opened again.
  const offered = useDecisionOffered(openedDoc);
  const showFooterDecision = Boolean(openedDoc && (offered || receiptState?.id === openedDoc.id));
  const filtered = Boolean(urlQuery || source || blockedOnly);
  const reset = () => { setBlockedKey(null); setDismissedKey(null); setQuery(""); set({ q: undefined, source: undefined, ...CLOSED }); };
  const handleSelect = (id: string) => { setDismissedKey(null); select(id); };
  const handleClose = () => { setDismissedKey(filterKey); select(undefined); };
  const refusedCount = items.filter(item => Boolean(item.decision_refusal)).length;
  const showStats = Boolean(
    first && (first.counts[box] > 0 || items.length > 0 || filtered || first.sources.length > 0),
  );
  const statItems: StatRowItem[] = showStats && first
    ? [
        {
          key: "all",
          label: t("approvals.console.all"),
          value: fmtNumber(first.counts[box]),
          active: !source && !blockedOnly,
          onPress: () => {
            setBlockedKey(null);
            setDismissedKey(null);
            set({ source: undefined, ...CLOSED });
          },
        },
        ...first.sources.map(src => ({
          key: `src-${src.key}`,
          label: src.label,
          value: fmtNumber(src.count),
          active: !blockedOnly && source === src.key,
          onPress: () => {
            setBlockedKey(null);
            setDismissedKey(null);
            set({ source: source === src.key ? undefined : src.key, ...CLOSED });
          },
        })),
        ...(refusedCount > 0
          ? [
              {
                key: "needs-check",
                label: t("approvals.console.needsCheck"),
                value: fmtNumber(refusedCount),
                tone: "warn" as const,
                active: blockedOnly,
                onPress: () => {
                  const nextBaseFilterKey = `${box}|${urlQuery}|`;
                  setDismissedKey(null);
                  setBlockedKey(prev => (prev === baseFilterKey ? null : nextBaseFilterKey));
                  if (source) set({ source: undefined, ...CLOSED });
                  else select(undefined);
                },
              },
            ]
          : first.sources.length <= 1 && items.length > 0
            ? [
                {
                  key: "actionable",
                  label: t("approvals.console.actionable"),
                  value: fmtNumber(items.length),
                  tone: "ok" as const,
                },
              ]
            : []),
      ]
    : [];

  return (
    <Worklist
      q={inbox}
      viewportLock
      tabs={tabs}
      head={{ title: t("approvals.title"), titleId: "approvals-title", actions: <NewApprovalLink /> }}
      find={<div ref={findBox} data-list-find=""><WorklistSearchField label={t("approvals.filters.search")} value={query} onChange={setQuery} /></div>}
      filters={<div ref={filters} className={s.consoleFilters} role="group" aria-label={t("approvals.filters.label")}>
        <SelectField hideLabel label={t("approvals.filters.source")} placeholder={t("approvals.filters.allSources")} options={sourceOptions} value={source ?? ALL_SOURCES} onChange={id => { setBlockedKey(null); setDismissedKey(null); set({ source: id === ALL_SOURCES ? undefined : id, ...CLOSED }); }} />
        {filtered && <Button variant="ghost" size="sm" onClick={reset}>{t("approvals.filters.reset")}</Button>}
      </div>}
      stats={statItems.length > 0 ? <StatRow items={statItems} label={t("approvals.console.kpiLabel")} phoneCols={statItems.length >= 6 ? 3 : undefined} /> : undefined}
      list={() => (
        <ConsoleApprovalsTable
          ref={rows}
          items={visibleItems}
          sel={effectiveSel}
          onSelect={handleSelect}
          hasNext={!blockedOnly && inbox.hasNextPage}
          loadingMore={inbox.isFetchingNextPage}
          onMore={() => void inbox.fetchNextPage()}
          emptyTitle={t(`approvals.empty.${box}`)}
        />
      )}
      onSelect={handleSelect}
      full={full}
      onFull={on => {
        if (!on) restore();
        else if (sel) expand();
        else if (effectiveSel) { setDismissedKey(null); set({ sel: effectiveSel, full: 1 }); }
      }}
      record={effectiveSel ? {
        id: effectiveSel,
        label: t("approvals.document.title"),
        title: selected?.document_no
          ? `${t("home.worklist.selectedMeta")} · ${selected.document_no}`
          : t("approvals.document.title"),
        openInTab: { href: `/approvals/${encodeURIComponent(effectiveSel)}`, label: selected?.title ?? effectiveSel },
        onClose: handleClose,
        // A decided document leaves the pending list: focus then goes to the first row left, or to the find box of an empty list.
        returnFocus: () => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(effectiveSel)}"]`)
          ?? rows.current?.querySelector<HTMLElement>("[data-id]") ?? findBox.current?.querySelector("input"),
        footer: showFooterDecision && openedDoc ? (
          <ApprovalDecisionPanel
            key={openedDoc.id}
            document={openedDoc}
            receipt={receiptState?.id === openedDoc.id ? receiptState.text : undefined}
            onReceipt={text => setReceiptState({ id: openedDoc.id, text })}
            // A decided document leaves the pending list: one the inbox opened by itself is chosen, so it stays open with its receipt.
            onDecisionStart={() => { if (!sel) select(openedDoc.id); }}
            docked
            compact
          />
        ) : undefined,
        children: <QueryState key={effectiveSel} q={opened} layout="record">{document => <ConsoleApprovalSideView document={document} />}</QueryState>,
      } : null}
      statusSegments={first ? [
        { id: "total", content: t("approvals.console.statusTotal", { count: first.counts[box] }) },
        ...(selected ? [{ id: "selected", tone: "strong" as const, content: t("approvals.console.statusSelected", { doc: selected.document_no ?? selected.title }) }] : []),
      ] : null}
    />
  );
}

const LazyApprovalNewPage = lazy(() => import("./approval-new-page").then(m => ({ default: m.ApprovalNewPage })));
export function ApprovalNew() { return <Suspense fallback={null}><LazyApprovalNewPage /></Suspense>; }
export function ApprovalsPage() {
  return <ExperienceSwitch baseline={() => <BaselineApprovalsPage />}>{() => <ConsoleApprovalsPage />}</ExperienceSwitch>;
}

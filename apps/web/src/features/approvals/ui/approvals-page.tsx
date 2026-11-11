// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { SEARCH_DEBOUNCE_MS } from "../../../lib/freshness";
import { codeText } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { columnSelection } from "../../../lib/react/use-column-selection";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { FlexibleColumns } from "../../../ui/flexible-columns/flexible-columns";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { SearchField } from "../../../ui/search/search-field";
import { SelectField } from "../../../ui/select/select-field";
import { Table } from "../../../ui/table";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { approvalDocumentQuery, approvalPages, type ApprovalItem } from "../api";
import { APPROVAL_BOXES, type ApprovalBox } from "../domain/inbox";
import { ApprovalDocumentView } from "./approval-viewer";
import { SourceViewerLink } from "./source-viewer-link";
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
  const list = <Card label={t("approvals.list")} flush>
    {items.length ? <div className={s.list}>
      <Table label={t("approvals.list")} rows={items} rowId={item => item.id} selected={sel} onSelect={onSelect} columns={[
        { header: t("approvals.field.documentNo"), card: "fact", fit: true, cell: item => <code className={s.secondary} title={item.document_no ?? "—"}>{item.document_no ?? "—"}</code> },
        { header: t("approvals.col.title"), card: "title", cell: item => <span className={s.title} title={item.title}>{item.title}</span> },
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
    returnFocus: () => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(sel)}"]`),
    children: <>
      {selected && <div className={s.meta}><Chip>{selected.source.label}</Chip><Chip tone={selected.status.tone}>{selected.status.label}</Chip></div>}
      {selected?.decision_refusal && <KeyValue readOnly items={[{ key: "decision-refusal", label: t("approvals.field.verification"), value: codeText(selected.decision_refusal, t("approvals.blocked")) }]} />}
      {record}
    </>,
  }} />;
}

export function ApprovalsPage() {
  const search = route.useSearch();
  const { box = "pending", q: urlQuery = "", source } = search;
  const navigate = route.useNavigate();
  const { sel, full, expand, restore, select } = columnSelection(search, navigate);
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
  const inbox = useInfiniteQuery({ ...approvalPages({ box, q: urlQuery || undefined, source }), placeholderData: keepPreviousData, refetchOnMount: "always" });
  const pages = inbox.data?.pages;
  const first = pages?.[0];
  const items = pages?.flatMap(page => page.items) ?? [];
  // The document is read by its id, so selecting never re-reads the list and a shared or reloaded link needs no list row.
  const opened = useQuery({ ...approvalDocumentQuery(sel ?? ""), enabled: Boolean(sel), refetchOnMount: "always" });
  const selected = (opened.data?.id === sel ? opened.data : undefined) ?? items.find(item => item.id === sel);
  const filtered = Boolean(urlQuery || source);
  const tabs = <TabNav label={t("approvals.tabs")} overflow="scroll">{APPROVAL_BOXES.map(id => <Link
    key={id} to="/approvals" search={{ box: id === "pending" ? undefined : id, q: urlQuery || undefined, source }}
    className={tabClass} aria-current={box === id ? "page" : undefined} resetScroll={false}
  >{t(`approvals.box.${id}`)}<TabCount>{first?.counts[id]}</TabCount></Link>)}</TabNav>;
  const sourceOptions = [{ id: ALL_SOURCES, label: t("approvals.filters.allSources") }, ...(first?.sources ?? []).map(item => ({ id: item.key, label: t("approvals.source.count", { label: item.label, count: item.count }) }))];
  const reset = () => { setQuery(""); set({ q: undefined, source: undefined, ...CLOSED }); };
  return <Page floorplan="P-03" head={{ title: t("approvals.title"), tabs }} toolbar={<div ref={filters} className={s.filters} role="group" aria-label={t("approvals.filters.label")}>
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
  </Page>;
}

// SPDX-License-Identifier: LicenseRef-Proprietary
import { useCallback, useEffect, useRef, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { SEARCH_DEBOUNCE_MS } from "../../../lib/freshness";
import { QueryState } from "../../../lib/react/query-state";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { ChainStepper } from "../../../ui/chain-stepper/chain-stepper";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Page } from "../../../ui/page/page";
import { SearchField } from "../../../ui/search/search-field";
import { SelectField } from "../../../ui/select/select-field";
import { SidePanel } from "../../../ui/side-panel/side-panel";
import { Table } from "../../../ui/table";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { tabClass } from "../../../ui/tabs/tab-class";
import { approvalPages, type ApprovalItem } from "../api";
import { APPROVAL_BOXES, type ApprovalBox } from "../domain/inbox";
import s from "./approvals-page.module.css";

const route = getRouteApi("/app/approvals");
const ALL_SOURCES = "all";

export function ApprovalInboxView({ items, selected, onSelect, onClose, hasNext, loadingMore, onMore, emptyTitle }: {
  items: ApprovalItem[];
  selected?: ApprovalItem;
  onSelect: (id: string) => void;
  onClose: () => void;
  hasNext?: boolean;
  loadingMore?: boolean;
  onMore?: () => void;
  emptyTitle?: string;
}) {
  return <div className="split" data-open={Boolean(selected)}>
    <Card label={t("approvals.list")} flush>
      {items.length ? <>
        <Table label={t("approvals.list")} rows={items} rowId={item => item.id} selected={selected?.id} onSelect={onSelect} columns={[
          { header: t("approvals.field.documentNo"), card: "fact", cell: item => <code className={s.nowrap}>{item.document_no ?? "—"}</code>, fit: true },
          { header: t("approvals.col.title"), card: "title", cell: item => item.title },
          { header: t("approvals.col.source"), card: "fact", cell: item => item.source.label, fit: true },
          { header: t("approvals.preview.route"), card: "fact", cell: item => {
            const current = item.route.find(step => step.state === "current");
            return current ? <strong className={s.nowrap} aria-current="step">{[current.label, current.assignee].filter(Boolean).join(" · ")}</strong> : "—";
          } },
          { header: t("approvals.col.requester"), card: "fact", cell: item => <span className={s.nowrap}>{item.requester?.name ?? "—"}</span>, fit: true },
          { header: t("approvals.col.requestedAt"), card: "fact", cell: item => <time className="num" dateTime={item.requested_at}>{fmtDateTime(item.requested_at)}</time>, fit: true },
          { header: t("approvals.col.status"), card: "status", cell: item => <Chip tone={item.status.tone}>{item.status.label}</Chip>, fit: true },
        ]} />
        {hasNext && <div className={s.more}><Button disabled={loadingMore} onClick={onMore}>{t("approvals.more")}</Button></div>}
      </> : <EmptyState title={emptyTitle ?? t("approvals.empty.title")} reason={t("approvals.empty.reason")} />}
    </Card>
    {selected && <SidePanel
      open title={selected.title} crumb={selected.document_no} onClose={onClose}
      chips={<><Chip>{selected.source.label}</Chip><Chip tone={selected.status.tone}>{selected.status.label}</Chip></>}
      openLink={<Link className={buttonClass("primary")} to="/approvals/$approvalId" params={{ approvalId: selected.id }}>{t("approvals.open")}</Link>}
      returnFocus={() => document.querySelector<HTMLElement>(`[data-id="${CSS.escape(selected.id)}"]`)}
    >
      <div className={s.preview}>
        <div>{selected.summary}</div>
        <KeyValue label={t("approvals.preview.facts")} readOnly items={[
          ...(selected.document_no ? [{ key: "number", label: t("approvals.field.documentNo"), value: selected.document_no }] : []),
          { key: "requester", label: t("approvals.field.requester"), value: [selected.requester?.name, selected.requester?.role].filter(Boolean).join(" · ") || "—" },
          { key: "requested", label: t("approvals.field.requestedAt"), value: fmtDateTime(selected.requested_at) },
          ...(selected.due_at ? [{ key: "due", label: t("approvals.field.dueAt"), value: fmtDateTime(selected.due_at) }] : []),
          ...selected.facts.map(fact => ({ ...fact })),
        ]} />
        {selected.route.length > 0 && <ChainStepper label={t("approvals.preview.route")} steps={selected.route.map(step => ({ key: step.id, who: [step.label, step.assignee].filter(Boolean).join(" · "), state: step.state, meta: step.meta }))} />}
      </div>
    </SidePanel>}
  </div>;
}

export function ApprovalsPage() {
  const { box = "pending", q: urlQuery = "", source, focus } = route.useSearch();
  const navigate = route.useNavigate();
  const set = useCallback((patch: { box?: Exclude<ApprovalBox, "pending">; q?: string; source?: string; focus?: string }) => void navigate({ search: previous => ({ ...previous, ...patch }), replace: true, resetScroll: false }), [navigate]);
  const [query, setQuery] = useState(urlQuery);
  const pushed = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery !== pushed.current) { pushed.current = urlQuery; setQuery(urlQuery); }
  }, [urlQuery]);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (query === pushed.current) return;
      pushed.current = query;
      set({ q: query.trim() || undefined, focus: undefined });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, set]);
  const inbox = useInfiniteQuery({ ...approvalPages({ box, q: urlQuery || undefined, source, focus }), placeholderData: keepPreviousData, refetchOnMount: "always" });
  const pages = inbox.data?.pages;
  const first = pages?.[0];
  const items = pages?.flatMap(page => page.items) ?? [];
  const selected = first?.focused ?? items.find(item => item.id === focus);
  const filtered = Boolean(urlQuery || source);
  const tabs = <TabNav label={t("approvals.tabs")} overflow="scroll">{APPROVAL_BOXES.map(id => <Link
    key={id} to="/approvals" search={{ box: id === "pending" ? undefined : id, q: urlQuery || undefined, source, focus: undefined }}
    className={tabClass} aria-current={box === id ? "page" : undefined} resetScroll={false}
  >{t(`approvals.box.${id}`)}<TabCount>{first?.counts[id]}</TabCount></Link>)}</TabNav>;
  const sourceOptions = [{ id: ALL_SOURCES, label: t("approvals.filters.allSources") }, ...(first?.sources ?? []).map(item => ({ id: item.key, label: t("approvals.source.count", { label: item.label, count: item.count }) }))];
  const reset = () => { setQuery(""); set({ q: undefined, source: undefined, focus: undefined }); };
  return <Page floorplan="P-03" head={{ title: t("approvals.title"), tabs }} toolbar={<div className={s.filters} role="group" aria-label={t("approvals.filters.label")}>
    <SearchField label={t("approvals.filters.search")} value={query} onChange={setQuery} />
    <SelectField hideLabel label={t("approvals.filters.source")} placeholder={t("approvals.filters.allSources")} options={sourceOptions} value={source ?? ALL_SOURCES} onChange={id => set({ source: id === ALL_SOURCES ? undefined : id, focus: undefined })} />
    {filtered && <Button variant="ghost" onClick={reset}>{t("approvals.filters.reset")}</Button>}
  </div>}>
    <QueryState q={inbox} layout="list">{() => <ApprovalInboxView
      items={items} selected={selected ?? undefined} onSelect={id => set({ focus: id })} onClose={() => set({ focus: undefined })}
      hasNext={inbox.hasNextPage} loadingMore={inbox.isFetchingNextPage} onMore={() => void inbox.fetchNextPage()}
      emptyTitle={t(`approvals.empty.${box}`)}
    />}</QueryState>
  </Page>;
}

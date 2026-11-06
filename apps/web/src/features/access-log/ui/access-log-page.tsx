// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { announce } from "../../../lib/react/announce";
import { SEARCH_DEBOUNCE_MS } from "../../../lib/freshness";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { Page } from "../../../ui/page/page";
import { Sheet } from "../../../ui/sheet/sheet";
import { SearchField } from "../../../ui/search/search-field";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { accessLogPages, type AccessLogEvent, type AccessLogFlag } from "../api";

const route = getRouteApi("/app/audit/access-log");
const flagText = (flag: AccessLogFlag) => t(`accessLog.flag.${flag}`);

export function AccessLogPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [selected, setSelected] = useState<AccessLogEvent | null>(null);
  const [searchText, setSearchText] = useState(search.search ?? "");
  const searchQuery = search.search ?? "";
  const [previousQuery, setPreviousQuery] = useState(searchQuery);
  if (previousQuery !== searchQuery) {
    setPreviousQuery(searchQuery);
    setSearchText(searchQuery);
  }
  const [composing, setComposing] = useState(false);
  useEffect(() => {
    if (composing) return;
    if (searchText.trim() === searchQuery) return;
    const timer = setTimeout(() => void navigate({ search: s => ({ ...s, search: searchText.trim() || undefined }), replace: true, resetScroll: false }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchText, composing, searchQuery, navigate]);
  const all = search.view === "all";
  const q = useInfiniteQuery({ ...accessLogPages(search.period, !all, searchQuery || undefined), placeholderData: keepPreviousData });
  const first = q.data?.pages[0];
  const count = all ? first?.totals.events : first?.totals.flagged;
  useEffect(() => {
    if (searchQuery && q.isSuccess && !q.isPlaceholderData && !q.isFetching && count !== undefined) announce(t("accessLog.searchCount", { count }));
  }, [searchQuery, count, q.isSuccess, q.isPlaceholderData, q.isFetching]);
  const period = search.period ?? first?.period.from.slice(0, 7) ?? "";
  return <Page floorplan="P-01" head={{ title: t("audit.title"), tabs: <AuditTabs /> }} q={q}
    toolbar={<div className="form">
        <SearchField label={t("accessLog.search")} value={searchText} onChange={setSearchText}
          onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
        <Field label={t("accessLog.period")} required={null}>{p => <TextInput {...p} type="month" value={period} onChange={e => void navigate({ search: s => ({ ...s, period: e.target.value || undefined }), replace: true })} />}</Field>
        <TabNav label={t("accessLog.views")} overflow="scroll">
          <Link to="/audit/access-log" search={{ period: search.period, search: search.search }} className={tabClass}>{t("accessLog.flagged")}<TabCount>{q.error ? undefined : first?.totals.flagged}</TabCount></Link>
          <Link to="/audit/access-log" search={{ period: search.period, view: "all", search: search.search }} className={tabClass}>{t("accessLog.all")}<TabCount>{q.error ? undefined : first?.totals.events}</TabCount></Link>
        </TabNav>
      </div>}
    sheet={selected && <Sheet open title={selected.actor_name} onClose={() => setSelected(null)} consequence={null}
      actions={<Button onClick={() => setSelected(null)}>{t("uiSheet.close")}</Button>}>
      <KeyValue readOnly items={[
        { key: "action", label: t("accessLog.action"), value: codeText(`accessLog.action.${selected.action}`, selected.action) },
        { key: "at", label: t("accessLog.at"), value: fmtDateTime(selected.occurred_at) },
        { key: "ip", label: t("accessLog.ip"), value: selected.ip ?? "—" },
        { key: "purpose", label: t("accessLog.purpose"), value: selected.export_purpose ?? "—" },
        { key: "flags", label: t("accessLog.flags"), value: selected.flags.map(flagText).join(" · ") },
      ]} />
    </Sheet>}>
      {data => {
        const page = data.pages[0]!;
        const rows = data.pages.flatMap(p => p.items);
        return <Card title={t("accessLog.title")} flush>
          {!rows.length ? <EmptyState title={t(searchQuery ? "accessLog.noResults" : "accessLog.empty")}
            reason={t(searchQuery ? "accessLog.noResultsReason" : "accessLog.emptyReason")}
            actions={searchQuery && <Button onClick={() => setSearchText("")}>{t("accessLog.clearSearch")}</Button>} /> : <>
            <StatRow label={t("accessLog.summary")} items={[
              { key: "events", label: t("accessLog.all"), value: fmtNumber(page.totals.events) },
              { key: "flagged", label: t("accessLog.flagged"), value: fmtNumber(page.totals.flagged) },
            ]} />
            <LongTable label={t("accessLog.table")} rows={rows} rowId={row => row.event_id} total={all ? page.totals.events : page.totals.flagged}
              hasMore={q.hasNextPage} loadingMore={q.isFetchingNextPage} onLoadMore={() => void q.fetchNextPage()}
              empty={t("accessLog.empty")} onRowAction={id => setSelected(rows.find(row => row.event_id === id) ?? null)}
              columns={[
                { id: "actor", header: t("accessLog.actor"), card: "title", rowHeader: true, cell: row => row.actor_name },
                { id: "action", header: t("accessLog.action"), card: "fact", cell: row => codeText(`accessLog.action.${row.action}`, row.action) },
                { id: "subjects", header: t("accessLog.subjects"), card: "fact", type: "num", cell: row => fmtNumber(row.subject_count) },
                { id: "outcome", header: t("accessLog.outcome"), card: "status", cell: row => <Chip tone={row.outcome === "DENIED" ? "warn" : "neutral"}>{t(`accessLog.outcome.${row.outcome}`)}</Chip> },
                { id: "flags", header: t("accessLog.flags"), card: "status", cell: row => row.flags.map(flag => <Chip key={flag} tone="warn">{flagText(flag)}</Chip>) },
                { id: "at", header: t("accessLog.at"), card: "fact", type: "date", cell: row => fmtDateTime(row.occurred_at) },
              ]} />
          </>}
        </Card>;
      }}
  </Page>;
}

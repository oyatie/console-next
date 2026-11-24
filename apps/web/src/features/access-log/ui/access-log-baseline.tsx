// SPDX-License-Identifier: LicenseRef-Proprietary
import { Suspense, type ReactNode } from "react";
import { type InfiniteData, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { ReadReference } from "../../../lib/react/read-reference";
import { readFailureText } from "../../../lib/refusal";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { Page } from "../../../ui/page/page";
import { SearchField } from "../../../ui/search/search-field";
import { Sheet } from "../../../ui/sheet/sheet";
import { tabClass } from "../../../ui/tabs/tab-class";
import { TabCount, TabNav } from "../../../ui/tabs/tabs";
import type { AccessLogEvent, AccessLogFlag, AccessLogPage as LogPage } from "../api";

const flagText = (flag: AccessLogFlag) => t(`accessLog.flag.${flag}`);

export function AccessLogBaselineView({
  q,
  first,
  filterInvalid,
  filtered,
  all,
  period,
  search,
  searchText,
  appliedFilters,
  selected,
  onSearchChange,
  onCompositionStart,
  onCompositionEnd,
  onNavigate,
  onOpenFilter,
  reviewButton,
  onOpenReview,
  onClear,
  onSelect,
  sheetNode,
}: {
  q: UseInfiniteQueryResult<InfiniteData<LogPage>>;
  first?: LogPage;
  filterInvalid: boolean;
  filtered: boolean;
  all: boolean;
  period: string;
  search: Record<string, string | undefined>;
  searchText: string;
  appliedFilters: { key: string; label: string; value: string | undefined }[];
  selected: AccessLogEvent | null;
  onSearchChange: (value: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onNavigate: (patch: Record<string, string | undefined>) => void;
  onOpenFilter: () => void;
  reviewButton: ReactNode;
  onOpenReview: (eventId: string | null) => void;
  onClear: () => void;
  onSelect: (event: AccessLogEvent | null) => void;
  sheetNode: ReactNode;
}) {
  const content = filterInvalid
    ? { children: <EmptyState alert title={t("accessLog.filterInvalid")} reason={readFailureText(q.error)} meta={<ReadReference error={q.error} />} /> }
    : {
        q,
        children: (data: InfiniteData<LogPage>) => {
          const page = data.pages[0]!;
          const rows = data.pages.flatMap(p => p.items);
          return (
            <Card title={t("accessLog.title")} flush>
              {!rows.length ? (
                <EmptyState title={t(filtered ? "accessLog.noResults" : "accessLog.empty")} reason={t(filtered ? "accessLog.noResultsReason" : "accessLog.emptyReason")} />
              ) : (
                <>
                  <StatRow
                    label={t("accessLog.summary")}
                    items={[
                      { key: "events", label: t("accessLog.all"), value: fmtNumber(page.totals.events), active: all, onPress: () => onNavigate({ view: "all" }) },
                      { key: "flagged", label: t("accessLog.flagged"), value: fmtNumber(page.totals.flagged), active: !all, onPress: () => onNavigate({ view: undefined }) },
                    ]}
                  />
                  <LongTable
                    label={t("accessLog.table")}
                    rows={rows}
                    rowId={row => row.event_id}
                    total={all ? page.totals.events : page.totals.flagged}
                    hasMore={q.hasNextPage}
                    loadingMore={q.isFetchingNextPage}
                    onLoadMore={() => void q.fetchNextPage()}
                    empty={t("accessLog.empty")}
                    onRowAction={id => onSelect(rows.find(row => row.event_id === id) ?? null)}
                    columns={[
                      { id: "actor", header: t("accessLog.actor"), card: "title", rowHeader: true, cell: row => row.actor_name },
                      { id: "action", header: t("accessLog.action"), card: "fact", cell: row => codeText(`accessLog.action.${row.action}`, row.action) },
                      { id: "subjects", header: t("accessLog.subjects"), card: "fact", type: "num", cell: row => fmtNumber(row.subject_count) },
                      { id: "outcome", header: t("accessLog.outcome"), card: "status", cell: row => <Chip tone={row.outcome === "DENIED" ? "warn" : "neutral"}>{t(`accessLog.outcome.${row.outcome}`)}</Chip> },
                      { id: "flags", header: t("accessLog.flags"), card: "status", cell: row => row.flags.map(flag => <Chip key={flag} tone="warn">{flagText(flag)}</Chip>) },
                      { id: "at", header: t("accessLog.at"), card: "fact", type: "date", width: 200, cell: row => fmtDateTime(row.occurred_at) },
                    ]}
                  />
                </>
              )}
            </Card>
          );
        },
      };
  return (
    <Page
      {...content}
      floorplan="P-01"
      head={{ title: t("audit.title"), tabs: <AuditTabs /> }}
      toolbar={
        <div className="form">
          <Field label={t("accessLog.period")} required={null}>
            {p => <TextInput {...p} type="month" value={period} onChange={e => onNavigate({ period: e.target.value || undefined, actor: undefined, action: undefined, target_type: undefined, from: undefined, to: undefined })} />}
          </Field>
          <TabNav label={t("accessLog.views")} overflow="scroll">
            <Link to="/audit/access-log" search={{ ...search, view: undefined }} className={tabClass}>{t("accessLog.flagged")}<TabCount>{q.error ? undefined : first?.totals.flagged}</TabCount></Link>
            <Link to="/audit/access-log" search={{ ...search, view: "all" }} className={tabClass}>{t("accessLog.all")}<TabCount>{q.error ? undefined : first?.totals.events}</TabCount></Link>
          </TabNav>
          <SearchField label={t("accessLog.search")} value={searchText} onChange={onSearchChange} onCompositionStart={onCompositionStart} onCompositionEnd={onCompositionEnd} />
          <div className="row wrap">
            <Button disabled={!first && !filterInvalid} onClick={onOpenFilter}>{t("accessLog.chooseFilters")}</Button>
            {reviewButton}
            {filtered && <Button onClick={onClear}>{t("accessLog.clearSearch")}</Button>}
          </div>
          {!!appliedFilters.length && <KeyValue label={t("accessLog.appliedFilters")} items={appliedFilters} readOnly />}
        </div>
      }
      sheet={
        sheetNode ? <Suspense fallback={null}>{sheetNode}</Suspense> : selected && (
          <Sheet
            open
            title={selected.actor_name}
            onClose={() => onSelect(null)}
            consequence={null}
            actions={
              <>
                {Boolean(period) && (
                  <Button variant="primary" onClick={() => { const id = selected.event_id; onSelect(null); onOpenReview(id); }}>
                    {t("accessLog.review.recordForEvent")}
                  </Button>
                )}
                <Button onClick={() => onSelect(null)}>{t("uiSheet.close")}</Button>
              </>
            }
          >
            <KeyValue
              readOnly
              items={[
                { key: "action", label: t("accessLog.action"), value: codeText(`accessLog.action.${selected.action}`, selected.action) },
                { key: "at", label: t("accessLog.at"), value: fmtDateTime(selected.occurred_at) },
                { key: "ip", label: t("accessLog.ip"), value: selected.ip ?? "—" },
                { key: "purpose", label: t("accessLog.purpose"), value: selected.export_purpose ?? "—" },
                { key: "flags", label: t("accessLog.flags"), value: selected.flags.map(flagText).join(" · ") },
              ]}
            />
          </Sheet>
        )
      }
    />
  );
}

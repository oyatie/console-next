// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useEffect, useState } from "react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime, fmtNumber } from "@console/i18n/format";
import { readFailureText } from "../../../lib/refusal";
import { ReadReference } from "../../../lib/react/read-reference";
import { codeText } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { announce } from "../../../lib/react/announce";
import { SEARCH_DEBOUNCE_MS } from "../../../lib/freshness";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { Button, type ButtonSize } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { PeriodStepper } from "../../../ui/period-stepper";
import { SearchField } from "../../../ui/search/search-field";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import accessLogStyles from "./access-log.module.css";
import { ApiError, accessLogPages, type AccessLogEvent, type AccessLogFlag } from "../api";
import { AccessLogBaselineView } from "./access-log-baseline";
import { AccessLogFilterSheet } from "./access-log-filter-sheet";

const AccessLogReviewSheet = lazy(() =>
  import("./access-log-review-sheet").then(m => ({ default: m.AccessLogReviewSheet })),
);
const AccessLogInspector = lazy(() =>
  import("./access-log-inspector").then(m => ({ default: m.AccessLogInspector })),
);

const route = getRouteApi("/app/audit/access-log");
const flagText = (flag: AccessLogFlag) => t(`accessLog.flag.${flag}`);

export function AccessLogPage() {
  const isDesktop = useIsDesktop();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const [filterOpen, setFilterOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewEventId, setReviewEventId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AccessLogEvent | null>(null);
  const [dismissedAuto, setDismissedAuto] = useState(false);
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
  const { actor, action, target_type, from, to } = search;
  const filters = { actor, action, target_type, from, to };
  const filtered = Boolean(searchQuery || actor || action || target_type || from || to);
  const clear = () => { setSearchText(""); void navigate({ search: s => ({ period: s.period, view: s.view }), replace: true }); };
  const all = search.view === "all";
  const q = useInfiniteQuery({ ...accessLogPages(search.period, !all, searchQuery || undefined, filters), placeholderData: keepPreviousData });
  const first = q.data?.pages[0];
  const filterInvalid = q.error instanceof ApiError && q.error.status === 422 && q.error.code === "filter_invalid";
  // Until choices have their own endpoint, recover with the smallest authorized log read.
  const choices = useInfiniteQuery({ ...accessLogPages(search.period, false, undefined, {}, 1), enabled: filterInvalid && !first?.filter_options });
  const source = first ?? (filterInvalid ? choices.data?.pages[0] : undefined);
  // Show the rows together on the initial read so the actor name cannot push the other filters down.
  const actorLabelPending = Boolean(actor) && !source && q.isPending;
  // A recovery alert may contain a copy button. Reserve the actor row above it while choices resolve.
  const actorLabel = actor && (source?.filter_options
    ? source.filter_options.actors.find(choice => choice.id === actor)?.label ?? t("accessLog.actorUnavailable")
    : filterInvalid ? t("accessLog.actorNameUnconfirmed") : undefined);
  const appliedFilters = actorLabelPending ? [] : [
    { key: "actor", label: t("accessLog.actor"), value: actorLabel },
    { key: "action", label: t("accessLog.action"), value: action && codeText(`accessLog.action.${action}`, action) },
    { key: "target_type", label: t("accessLog.targetType"), value: target_type && codeText(`accessLog.target.${target_type}`, target_type) },
    { key: "from", label: t("accessLog.from"), value: from && fmtDate(from) },
    { key: "to", label: t("accessLog.to"), value: to && fmtDate(to) },
  ].filter(item => item.value);
  const count = all ? first?.totals.events : first?.totals.flagged;
  useEffect(() => {
    if (filtered && q.isSuccess && !q.isPlaceholderData && !q.isFetching && count !== undefined) announce(t("accessLog.searchCount", { count }));
  }, [filtered, count, q.isSuccess, q.isPlaceholderData, q.isFetching]);
  const period = search.period ?? source?.period.from.slice(0, 7) ?? "";
  const consoleRows = q.data?.pages.flatMap(p => p.items) ?? [];
  const effectiveSelected =
    selected ?? (isDesktop && !dismissedAuto ? (consoleRows[0] ?? null) : null);

  const openReview = (eventId: string | null) => { setReviewEventId(eventId); setReviewOpen(true); };
  const filtersDisabled = !first && !filterInvalid;
  const reviewDisabled = !period || filtersDisabled;
  const reviewError = filterInvalid ? choices.error : q.error;
  const reviewReason = reviewDisabled && reviewError ? readFailureText(reviewError) : undefined;
  const filterAlert = filterInvalid && <EmptyState alert title={t("accessLog.filterInvalid")}
    reason={[readFailureText(q.error), reviewReason].filter(Boolean).join(" ")}
    meta={<ReadReference error={q.error} />}
  />;
  const renderReviewButton = (size?: ButtonSize) => {
    const label = t("accessLog.review.open");
    return reviewReason
      ? <DisabledReason reason={reviewReason} control={props => <Button size={size} title={reviewReason} {...props}>{label}</Button>}>
          {({ control, reason }) => <>{control}<div className="sr-only">{reason}</div></>}
        </DisabledReason>
      : <Button size={size} disabled={reviewDisabled} onClick={() => openReview(null)}>{label}</Button>;
  };
  const renderBaseline = () => (
    <AccessLogBaselineView
      q={q}
      first={first}
      filterAlert={filterAlert}
      filtered={filtered}
      all={all}
      period={period}
      search={search}
      searchText={searchText}
      appliedFilters={appliedFilters}
      selected={selected}
      onSearchChange={setSearchText}
      onCompositionStart={() => setComposing(true)}
      onCompositionEnd={() => setComposing(false)}
      onNavigate={patch => void navigate({ search: s => ({ ...s, ...patch }), replace: true })}
      onOpenFilter={filtersDisabled ? undefined : () => setFilterOpen(true)}
      reviewButton={renderReviewButton()}
      onOpenReview={openReview}
      onClear={clear}
      onSelect={setSelected}
      sheetNode={
        filterOpen ? (
          <AccessLogFilterSheet
            key={JSON.stringify({ ...filters, period: search.period })}
            source={first}
            choices={choices}
            value={filters}
            onClose={() => setFilterOpen(false)}
            onApply={next => {
              setFilterOpen(false);
              void navigate({ search: s => ({ period: s.period, view: s.view, search: s.search, ...next }), replace: true, resetScroll: false });
            }}
          />
        ) : reviewOpen && period ? (
          <AccessLogReviewSheet
            period={period}
            initialEventId={reviewEventId}
            onClose={() => { setReviewOpen(false); setReviewEventId(null); }}
          />
        ) : null
      }
    />
  );

  const consoleQuery = filterInvalid
    ? { isPending: false, isError: false, error: null, data: first ?? { period: { from: `${todayKst().slice(0, 7)}-01`, to: todayKst(), time_zone: "Asia/Seoul", closed: false }, totals: { events: 0, flagged: 0, by_flag: {} }, items: [], next_cursor: null }, refetch: q.refetch }
    : q;

  return (
    <ListRecord
      q={consoleQuery}
      tabs={<AuditTabs />}
      head={{
        title: t("audit.title"),
        titleId: "audit-access-log-title",
        actions: (
          <>
            <Button size="sm" variant="secondary" disabled={filtersDisabled} onClick={() => setFilterOpen(true)}>
              {t("accessLog.chooseFilters")}
            </Button>
            {renderReviewButton("sm")}
            {filtered && (
              <Button size="sm" variant="ghost" onClick={clear}>
                {t("accessLog.clearSearch")}
              </Button>
            )}
          </>
        ),
      }}
      filters={
        <PeriodStepper
          unit="month"
          variant="boxed"
          showCurrent={false}
          value={period || todayKst().slice(0, 7)}
          onChange={nextPeriod =>
            void navigate({
              search: s => ({ ...s, period: nextPeriod, actor: undefined, action: undefined, target_type: undefined, from: undefined, to: undefined }),
              replace: true,
            })
          }
        />
      }
      find={
        <div className={accessLogStyles.searchBox}>
          <SearchField label={t("accessLog.search")} value={searchText} onChange={setSearchText} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
        </div>
      }
      stats={
        !filterInvalid && first && consoleRows.length > 0 ? (
          <StatRow
            label={t("accessLog.summary")}
            items={[
              { key: "events", label: t("accessLog.all"), value: fmtNumber(first.totals.events), active: all, onPress: () => void navigate({ search: s => ({ ...s, view: "all" }) }) },
              { key: "flagged", label: t("accessLog.flagged"), value: fmtNumber(first.totals.flagged), active: !all, onPress: () => void navigate({ search: s => ({ ...s, view: undefined }) }) },
            ]}
          />
        ) : undefined
      }
      notes={appliedFilters.length ? <KeyValue label={t("accessLog.appliedFilters")} items={appliedFilters} readOnly /> : undefined}
      list={
        filterAlert || (!consoleRows.length ? (
          <EmptyState
            title={t(filtered ? "accessLog.noResults" : "accessLog.empty")}
            reason={t(filtered ? "accessLog.noResultsReason" : "accessLog.emptyReason")}
          />
        ) : (
          <LongTable
            label={t("accessLog.table")}
            rows={consoleRows}
            rowId={row => row.event_id}
            activeRowId={effectiveSelected?.event_id}
            total={all ? (first?.totals.events ?? consoleRows.length) : (first?.totals.flagged ?? consoleRows.length)}
            hasMore={q.hasNextPage}
            loadingMore={q.isFetchingNextPage}
            onLoadMore={() => void q.fetchNextPage()}
            density="compact"
            mobileLayout="compact"
            empty={t("accessLog.empty")}
            onRowAction={id => {
              setDismissedAuto(false);
              setSelected(consoleRows.find(row => row.event_id === id) ?? null);
            }}
            columns={[
              { id: "actor", header: t("accessLog.actor"), card: "title", rowHeader: true, cell: row => row.actor_name },
              { id: "action", header: t("accessLog.action"), card: "fact", cell: row => codeText(`accessLog.action.${row.action}`, row.action) },
              { id: "subjects", header: t("accessLog.subjects"), card: "omit", type: "num", width: 88, cell: row => fmtNumber(row.subject_count) },
              { id: "outcome", header: t("accessLog.outcome"), card: "status", width: 88, cell: row => <Chip tone={row.outcome === "DENIED" ? "danger" : "neutral"}>{t(`accessLog.outcome.${row.outcome}`)}</Chip> },
              { id: "flags", header: t("accessLog.flags"), card: "omit", cell: row => row.flags.map(flag => <Chip key={flag} tone="warn">{flagText(flag)}</Chip>) },
              { id: "at", header: t("accessLog.at"), card: "fact", type: "date", width: 200, cell: row => fmtDateTime(row.occurred_at) },
            ]}
          />
        ))
      }
      onSelect={id => {
        setDismissedAuto(false);
        setSelected(consoleRows.find(row => row.event_id === id) ?? null);
      }}
      record={
        !filterInvalid && effectiveSelected
          ? {
              id: effectiveSelected.event_id,
              label: t("accessLog.review.inspectorTitle"),
              title: effectiveSelected.actor_name,
              meta: codeText(`accessLog.action.${effectiveSelected.action}`, effectiveSelected.action),
              onClose: () => {
                setSelected(null);
                setDismissedAuto(true);
              },
              children: (
                <Suspense fallback={null}>
                  <AccessLogInspector
                    key={effectiveSelected.event_id}
                    event={effectiveSelected}
                    period={period || todayKst().slice(0, 7)}
                  />
                </Suspense>
              ),
            }
          : undefined
      }
      overlays={
        filterOpen ? (
          <AccessLogFilterSheet
            key={JSON.stringify({ ...filters, period: search.period })}
            source={first}
            choices={choices}
            value={filters}
            onClose={() => setFilterOpen(false)}
            onApply={next => {
              setFilterOpen(false);
              void navigate({ search: s => ({ period: s.period, view: s.view, search: s.search, ...next }), replace: true, resetScroll: false });
            }}
          />
        ) : reviewOpen && period ? (
          <Suspense fallback={null}>
            <AccessLogReviewSheet
              period={period}
              initialEventId={reviewEventId}
              onClose={() => { setReviewOpen(false); setReviewEventId(null); }}
            />
          </Suspense>
        ) : undefined
      }
      baseline={renderBaseline}
    />
  );
}

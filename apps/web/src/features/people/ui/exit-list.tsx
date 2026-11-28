import { useState, type ReactNode } from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button, ToggleButton } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { Count } from "../../../ui/count/count";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { WorklistSearchField, WorklistSegmentBar, WorklistSubject } from "../../../ui/patterns/worklist-parts";
import { usePrefetch } from "../../../lib/react/prefetch";
import { QueryState } from "../../../lib/react/query-state";
import { EXIT_CASE_STATUS, LIFECYCLE_STATE, actor, label, labeled } from "../../../lib/labels";
import { useCan } from "../../../reference/authz/ui/use-can";
import { caseQuery, exitCaseCountsQuery, exitCasesPagesQuery, OPEN_EXIT_STATUSES, type ExitFilter } from "../api";
import { forwardStep, usableActions } from "../domain/exits";
import { RelDay } from "./exit-facts";
import { PageHead } from "../../../ui/page-head/page-head";
import s from "./exit.module.css";

type Case = components["schemas"]["EmployeeExitCase"];
type Counts = components["schemas"]["ExitCaseCountsResponse"];
const PAGE = 100;
const route = getRouteApi("/app/people/exits");
/** The status views, each with the server's count: the open cases, each open step, the closed ones, all. */
const CHIPS: readonly (ExitFilter | undefined)[] = ["open", ...OPEN_EXIT_STATUSES, "closed", undefined];
const chipLabel = (f?: ExitFilter) =>
  f === undefined ? t("exit.list.chip.all") : f === "open" ? t("exit.list.chip.open") : f === "closed" ? t("exit.list.chip.closed") : label(EXIT_CASE_STATUS, f);
const STEP_OF = { confirm_exit: "HR_CONFIRMED", confirm_exit_hq: "HQ_CONFIRMED", prepare_settlement: "SETTLEMENT_READY" } as const;
const COUNT_KEY: Record<string, keyof Counts> = {
  all: "all",
  open: "open",
  closed: "closed",
  REPORTED: "reported",
  HR_CONFIRMED: "hr_confirmed",
  HQ_CONFIRMED: "hq_confirmed",
  SETTLEMENT_READY: "settlement_ready",
  APPROVAL_DRAFTED: "approval_drafted",
};
const countOf = (counts: Counts | undefined, f?: ExitFilter) => counts?.[COUNT_KEY[f ?? "all"] ?? "all"];

/**
 * Every exit case in the caller's scope, newest activity first: the way into a case at any step, reject
 * included. The status chips are the filter (in the URL, so Home links to the open cases), each counted
 * by the server; rows load in pages as the table scrolls. The name or employee-number search stays out of the URL
 * (and so out of history), as on the roster.
 */
export function ExitCaseList() {
  const { status } = route.useSearch();
  const navigate = route.useNavigate();
  return <ExitCaseListContent status={status} onStatus={next => void navigate({ search: next ? { status: next } : {}, replace: true })} />;
}

export function ExitCaseListContent({ status, onStatus: pick, tabs }: { status?: ExitFilter; onStatus: (status?: ExitFilter) => void; tabs?: ReactNode }) {
  const [q, setQ] = useState("");
  const [findSlot, setFindSlot] = useState<HTMLElement | null>(null);
  const can = useCan();
  const navigate = useNavigate();
  const prefetch = usePrefetch();
  const trimmed = q.trim();
  const counts = useQuery(exitCaseCountsQuery(trimmed));
  const list = useInfiniteQuery({ ...exitCasesPagesQuery(status, PAGE, trimmed), placeholderData: keepPreviousData, refetchInterval: false });
  const seen = new Set<string>();
  const rows = (list.data?.pages ?? []).flatMap((p) => p.items).filter((c) => !seen.has(c.id) && seen.add(c.id));
  const total = list.data?.pages[0]?.total ?? 0;
  const onReset = () => (setQ(""), pick());

  const makeColumns = (compact: boolean): LongColumn<Case>[] => [
    {
      id: "employee",
      header: t("exit.list.col.employee"),
      rowHeader: true,
      width: "2fr",
      card: compact ? "title" : undefined,
      cell: (c) => {
        const inner = (
          <span className={s.cellStack}>
            <Link to="/people/exits/$id" params={{ id: c.id }} search={{}} onFocus={() => prefetch(caseQuery(c.id))}>
              {c.employee_name}
            </Link>
            {c.employee_number && <span className="code muted">{c.employee_number}</span>}
          </span>
        );
        return compact ? <WorklistSubject title={c.employee_name}>{inner}</WorklistSubject> : inner;
      },
    },
    {
      id: "date",
      header: t("exit.field.date"),
      width: "2fr",
      card: compact ? "fact" : undefined,
      cell: (c) => {
        const ev = c.exit_event_state === "SCHEDULED" || c.exit_event_state === "APPLY_FAILED" ? labeled(LIFECYCLE_STATE, c.exit_event_state) : null;
        return (
          <span className={s.cellStack}>
            <span className="num">{fmtDate(c.effective_exit_date)}</span>
            <RelDay date={c.effective_exit_date} />
            {ev && <Chip tone={ev.tone}>{ev.label}</Chip>}
          </span>
        );
      },
    },
    { id: "reporter", header: t("exit.field.reporter"), card: compact ? "omit" : undefined, cell: (c) => actor(c.reported_by_name) },
    { id: "status", header: t("exit.list.col.status"), card: compact ? "status" : undefined, cell: (c) => { const st = labeled(EXIT_CASE_STATUS, c.status); return <Chip tone={st.tone}>{st.label}</Chip>; } },
    {
      id: "next",
      header: t("exit.list.col.next"),
      width: "1.5fr",
      card: compact ? "omit" : undefined,
      cell: (c) => {
        const next = c.exit_event_state === "APPLY_FAILED" ? null : forwardStep(c);
        if (!next) return "—";
        return (
          <bdi className={s.cellStack}>
            {t(`exit.step.${STEP_OF[next]}`)}
            {!compact && usableActions(c, can).includes(next) && <Chip tone="info">{t("exit.next.mine")}</Chip>}
          </bdi>
        );
      },
    },
    ...(compact ? [{
      id: "open",
      header: "",
      card: "action" as const,
      cell: (c: Case) => (
        <Button size="sm" variant="ghost" onClick={(ev) => { ev.stopPropagation(); void navigate({ to: "/people/exits/$id", params: { id: c.id }, search: {} }); }}>
          {t("empDoc.certificate.open")}
        </Button>
      ),
    }] : []),
  ];

  const emptyNode =
    status || trimmed ? (
      <EmptyState title={t("exit.list.noMatch.title")} reason={t("exit.list.noMatch.reason")} actions={<Button onClick={onReset}>{t("exit.list.filter.reset")}</Button>} />
    ) : (
      <EmptyState
        title={t("exit.list.empty.title")}
        reason={t("exit.list.empty.reason")}
        actions={can("exit_case_report") && <Link className={buttonClass()} to="/people" search={{}}>{t("exit.list.empty.action")}</Link>}
      />
    );

  const renderBaseline = () => (
    <div className="page">
      <PageHead title={t("exit.list.title")} />
      <section className="card">
        <div className={`tabs ${s.chips}`} role="group" aria-label={t("exit.list.chips")}>
          {CHIPS.map((f) => (
            <ToggleButton key={f ?? "all"} pressed={status === f} onClick={() => pick(f)}>
              {chipLabel(f)} <Count n={countOf(counts.data, f)} failed={counts.isError ? t("exit.list.countFailed") : undefined} />
            </ToggleButton>
          ))}
        </div>
        <div ref={setFindSlot} />
        <QueryState q={list} layout="list">
          {() => (
            <LongTable
              label={t("exit.list.title")}
              caption={t("exit.list.count", { count: total })}
              columns={makeColumns(false)}
              rows={rows}
              rowId={(c) => c.id}
              total={total}
              hasMore={list.hasNextPage}
              loadingMore={list.isFetchingNextPage}
              onLoadMore={() => void list.fetchNextPage()}
              find={{ label: t("exit.list.find"), defaultValue: q, onFind: (value) => setQ(value.trim()) }}
              findSlot={findSlot}
              onRowHover={(id) => prefetch(caseQuery(id))}
              onRowAction={(id) => void navigate({ to: "/people/exits/$id", params: { id }, search: {} })}
              empty={emptyNode}
            />
          )}
        </QueryState>
      </section>
    </div>
  );

  return (
    <ExperienceSwitch baseline={renderBaseline}>
      {() => (
        <ListRecord
          tabs={tabs}
          q={list}
          head={{ title: t("exit.list.title") }}
          views={
            <WorklistSegmentBar
              label={t("exit.list.chips")}
              phoneSelect
              size="sm"
              value={status ?? "__all__"}
              onChange={(id) => pick(id === "__all__" ? undefined : (id as ExitFilter))}
              items={CHIPS.map((f) => ({
                id: f ?? "__all__",
                label: chipLabel(f),
                count: counts.isError ? t("exit.list.countFailed") : countOf(counts.data, f),
              }))}
            />
          }
          find={<WorklistSearchField label={t("exit.list.find")} value={q} onChange={(value) => setQ(value.trimStart())} />}
          list={
            <div className={s.tableWrap}>
              <LongTable
                label={t("exit.list.title")}
                columns={makeColumns(true)}
                rows={rows}
                rowId={(c) => c.id}
                total={total}
                hasMore={list.hasNextPage}
                loadingMore={list.isFetchingNextPage}
                onLoadMore={() => void list.fetchNextPage()}
                density="compact"
                mobileLayout="compact"
                onRowHover={(id) => prefetch(caseQuery(id))}
                onRowAction={(id) => void navigate({ to: "/people/exits/$id", params: { id }, search: {} })}
                empty={emptyNode}
              />
            </div>
          }
          statusSegments={
            list.data
              ? [
                  { id: "scope", tone: "strong", content: t("exit.list.title") },
                  { id: "filter", content: chipLabel(status) },
                  { id: "count", content: t("exit.list.count", { count: total }) },
                ]
              : null
          }
        />
      )}
    </ExperienceSwitch>
  );
}

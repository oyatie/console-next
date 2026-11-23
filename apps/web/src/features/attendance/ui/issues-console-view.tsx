// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button-base";
import { buttonClass } from "../../../ui/button/button-class";
import { Chip } from "../../../ui/chip";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { exceptionDetailQuery, exceptionsQuery } from "../api";
import { dateText } from "../present";
import { AttendanceTabNav } from "./attendance-head";
import { PeriodStepper } from "./period-stepper";
import { ScopePicker } from "./scope-picker";
import s from "./attendance-console.module.css";

const RaiseExceptionSheet = lazy(() => chunk(import("./issues-console-sheets")).then((m) => ({ default: m.RaiseExceptionSheet })));
const ResolveExceptionSheet = lazy(() => chunk(import("./issues-console-sheets")).then((m) => ({ default: m.ResolveExceptionSheet })));

const route = getRouteApi("/app/attendance");

export function IssuesConsoleView({ baseline }: { baseline: () => React.ReactNode }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const month = search.month ?? (search.date ?? todayKst()).slice(0, 7);
  const query = useInfiniteQuery(exceptionsQuery(month, search.wp));
  const [selectedId, setSelectedId] = useState<string>();
  const [sheet, setSheet] = useState<"raise" | "resolve" | null>(null);
  const detailQuery = useQuery({ ...exceptionDetailQuery(selectedId ?? ""), enabled: Boolean(selectedId), retry: false });
  const go = (patch: Record<string, unknown>) => void navigate({ search: prev => ({ ...prev, ...patch }) });

  const rows = query.data?.pages.flatMap(page => page.items) ?? [];
  const total = query.data?.pages[0]?.total ?? rows.length;
  const selectedRow = rows.find(r => r.id === selectedId);
  const countKind = (kind: "LATE" | "NO_SHOW" | "UNAPPROVED_OVERTIME" | "EARLY_LEAVE") =>
    rows.filter(r => r.kind === kind).length;

  return (
    <ListRecord
      q={query}
      tabs={<AttendanceTabNav tab="issues" />}
      head={{
        title: t("attendance.title"),
        titleId: "attendance-issues-title",
        actions: (
          <Button size="sm" variant="primary" className={s.nowrap} onClick={() => setSheet("raise")}>
            {t("attendance.issues.raiseButton")}
          </Button>
        ),
      }}
      filters={
        <div className={s.filterPair}>
          <PeriodStepper unit="month" variant="boxed" showCurrent={false} value={month} onChange={nextMonth => go({ month: nextMonth })} />
          <ScopePicker compact value={search.wp} onChange={wp => go({ wp, unit: undefined })} />
        </div>
      }
      stats={
        rows.length > 0 ? (
          <StatRow
            label={t("attendance.tab.issues")}
            items={[
              { key: "late", label: t("attendance.exception.LATE"), value: countKind("LATE") },
              { key: "noshow", label: t("attendance.exception.NO_SHOW"), value: countKind("NO_SHOW"), tone: countKind("NO_SHOW") > 0 ? "danger" : undefined },
              { key: "ot", label: t("attendance.exception.UNAPPROVED_OVERTIME"), value: countKind("UNAPPROVED_OVERTIME"), tone: countKind("UNAPPROVED_OVERTIME") > 0 ? "warn" : undefined },
              { key: "early", label: t("attendance.exception.EARLY_LEAVE"), value: countKind("EARLY_LEAVE") },
            ]}
          />
        ) : undefined
      }
      list={
        <div className={s.tableWrap}>
          <LongTable
            label={t("attendance.tab.issues")}
            rows={rows}
            rowId={row => row.id}
            total={total}
            hasMore={query.hasNextPage}
            loadingMore={query.isFetchingNextPage}
            onLoadMore={() => void query.fetchNextPage()}
            density="compact"
            mobileLayout="compact"
            activeRowId={selectedRow?.id}
            onRowAction={id => setSelectedId(id)}
            empty={t("attendance.issues.empty")}
            columns={[
              { id: "person", header: t("attendance.col.person"), card: "title", rowHeader: true, cell: row => row.employee_name },
              { id: "date", header: t("attendance.col.date"), card: "fact", cell: row => dateText(row.work_date) },
              { id: "kind", header: t("attendance.col.kind"), card: "fact", cell: row => t(`attendance.exception.${row.kind}`) },
              {
                id: "state",
                header: t("attendance.col.state"),
                card: "status",
                cell: row => <Chip tone={row.status === "OPEN" ? "warn" : "ok"}>{t(`attendance.exception.${row.status}`)}</Chip>,
              },
            ]}
          />
        </div>
      }
      onSelect={id => setSelectedId(id)}
      record={
        selectedRow
          ? {
              id: selectedRow.id,
              label: t("attendance.issues.pane.title"),
              title: t("attendance.issues.pane.title"),
              onClose: () => setSelectedId(undefined),
              children: (
                <QueryState q={detailQuery} compact>
                  {exc => (
                    <div className={s.paneBody}>
                      <RecordIdentityBar
                        name={exc.employee_name}
                        badges={<Chip tone={exc.status === "OPEN" ? "warn" : "ok"}>{t(`attendance.exception.${exc.status}`)}</Chip>}
                        roleLine={t(`attendance.exception.${exc.kind}`)}
                        path={exc.team ?? undefined}
                      />
                      <RecordPaneSection title={t("attendance.issues.pane.title")}>
                        <KeyValue
                          density="dense"
                          label={t("attendance.issues.pane.title")}
                          items={[
                            { key: "date", label: t("attendance.col.date"), value: dateText(exc.work_date) },
                            ...(exc.team ? [{ key: "team", label: t("attendance.issues.pane.team"), value: exc.team }] : []),
                            { key: "detail", label: t("me.attendance.exceptions.col.detail"), value: exc.detail },
                          ]}
                        />
                      </RecordPaneSection>
                      {exc.evidence.length > 0 ? (
                        <RecordPaneSection title={t("attendance.issues.pane.evidence")}>
                          <KeyValue
                            density="dense"
                            label={t("attendance.issues.pane.evidence")}
                            items={exc.evidence.map((ev, i) => ({ key: `${ev.name}-${i}`, label: ev.name, value: ev.size ?? "—" }))}
                          />
                        </RecordPaneSection>
                      ) : null}
                      {exc.links.length > 0 ? (
                        <RecordPaneSection title={t("attendance.issues.pane.links")}>
                          <KeyValue
                            density="dense"
                            label={t("attendance.issues.pane.links")}
                            items={exc.links.map((lk, i) => ({ key: `${lk.kind}-${i}`, label: lk.label, value: lk.ref ?? "—" }))}
                          />
                        </RecordPaneSection>
                      ) : null}
                      <div className={s.paneActions}>
                        {exc.status === "OPEN" && (
                          <Button size="sm" variant="primary" className={s.nowrap} onClick={() => setSheet("resolve")}>
                            {t("attendance.issues.resolveButton")}
                          </Button>
                        )}
                        <Link
                          to="/attendance"
                          search={{ tab: "day", date: exc.work_date, wp: exc.branch_id ?? search.wp, person: undefined }}
                          className={buttonClass("secondary", { size: "sm", className: s.nowrap })}
                        >
                          {t("attendance.issues.pane.openDay")}
                        </Link>
                      </div>
                    </div>
                  )}
                </QueryState>
              ),
            }
          : null
      }
      overlays={
        sheet ? (
          <Suspense fallback={null}>
            {sheet === "raise" ? (
              <RaiseExceptionSheet defaultBranchId={search.wp} onClose={() => setSheet(null)} />
            ) : detailQuery.data ? (
              <ResolveExceptionSheet exception={detailQuery.data} onClose={() => setSheet(null)} />
            ) : null}
          </Suspense>
        ) : undefined
      }
      statusSegments={
        query.data
          ? [
              { id: "count", content: t("attendance.monthConsole.status.issues", { count: total }) },
              ...(selectedRow ? [{ id: "selected", tone: "strong" as const, content: `${selectedRow.employee_name} · ${dateText(selectedRow.work_date)}` }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}

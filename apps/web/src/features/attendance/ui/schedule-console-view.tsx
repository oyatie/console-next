// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { Receipt } from "../../../ui/receipt/receipt";
import { patternsQuery, treeQuery, type Layer } from "../api";
import { AssignSheet, type AssignTarget } from "./assign-sheet";
import { AttendanceTabNav } from "./attendance-head";
import type { AttendanceSearch, View } from "./attendance-page";
import { CalendarView } from "./calendar-view";
import { CancelLayerSheet } from "./cancel-layer-sheet";
import { CrewsView } from "./crews-view";
import { FirstRun } from "./first-run";
import { HolidaysView } from "./holidays-view";
import { PatternSheet } from "./pattern-sheet";
import { PatternsView } from "./patterns-view";
import { PublicHolidaysView } from "./public-holidays-view";
import s from "./attendance-console.module.css";

const route = getRouteApi("/app/attendance");
type Open = { assign: AssignTarget[] } | { pattern: true } | { cancel: Layer } | null;
const VIEWS: readonly View[] = ["calendar", "types", "crews", "holidays", "public"];

export function ScheduleConsoleView({ baseline }: { baseline: () => ReactNode }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const view = search.view ?? "calendar";
  const tree = useQuery(treeQuery());
  const patterns = useQuery(patternsQuery());
  const [open, setOpen] = useState<Open>(null);
  const [receipt, setReceipt] = useState<{ message: string; layer?: Layer } | null>(null);
  const go = (patch: Partial<AttendanceSearch>) => void navigate({ search: prev => ({ ...prev, ...patch }) });

  const assign = async (targets: AssignTarget[]) => {
    const list = patterns.isFetching ? (await patterns.refetch()).data : patterns.data;
    setOpen(list?.items.some(p => p.status === "ACTIVE") ? { assign: targets } : { pattern: true });
  };

  const tr = tree.data;

  return (
    <SettingsPattern
      q={tree}
      tabs={<AttendanceTabNav tab="schedule" />}
      head={{
        title: t("attendance.title"),
        titleId: "attendance-schedule-title",
      }}
      views={
        <nav aria-label={t("attendance.views")} className={s.scheduleRail}>
          {VIEWS.map(item => (
            <Button
              key={item}
              size="sm"
              variant={view === item ? "primary" : "ghost"}
              aria-pressed={view === item}
              className={s.nowrap}
              onClick={() => go({ view: item })}
            >
              {t(`attendance.view.${item}`)}
            </Button>
          ))}
        </nav>
      }
      notes={
        <>
          {receipt ? (
            <Receipt
              state="recorded"
              message={receipt.message}
              actions={
                receipt.layer && receipt.layer.state === "SCHEDULED" ? (
                  <Button variant="ghost" size="sm" onClick={() => setOpen({ cancel: receipt.layer! })}>
                    {t("attendanceSchedule.receipt.cancel")}
                  </Button>
                ) : undefined
              }
            />
          ) : null}
          {tr && tr.people_unscheduled > 0 ? (
            <RecordBannerBand tone="warn">
              <div className={s.scheduleHeader}>
                <bdi>{t("attendanceSchedule.unscheduled.banner", { count: tr.people_unscheduled, total: tr.people_total })}</bdi>
                <Link to="/attendance" search={{ tab: "day", date: tr.date, unscheduled: true }}>
                  {t("attendanceRecords.unscheduled.view", { count: tr.people_unscheduled })}
                </Link>
              </div>
            </RecordBannerBand>
          ) : null}
          {tr && !tr.holidays_loaded ? (
            <RecordBannerBand tone="warn">{t("attendanceHolidays.holidays.notLoaded", { year: tr.date.slice(0, 4) })}</RecordBannerBand>
          ) : null}
        </>
      }
      panel={
        tr ? (
          <div className={s.schedulePanel}>
            {tr.people_total > 0 && tr.people_unscheduled === tr.people_total && !tr.nodes.some(n => n.layer) ? (
              <FirstRun
                patterns={patterns.data?.items.length ?? 0}
                people={tr.people_total}
                onSchedule={() => (patterns.data?.items.length ? go({ view: "calendar" }) : setOpen({ pattern: true }))}
              />
            ) : null}
            {view === "calendar" ? (
              <CalendarView
                consoleMode
                tree={tr}
                search={search}
                onScope={(kind, scopeId) => go({ kind, id: scopeId })}
                onMonth={month => go({ month })}
                onAddPattern={() => setOpen({ pattern: true })}
                onAssign={assign}
                onCancel={layer => setOpen({ cancel: layer })}
              />
            ) : view === "types" ? (
              <PatternsView
                consoleMode
                onAdd={() => setOpen({ pattern: true })}
                onRetired={name => setReceipt({ message: t("attendancePatterns.pattern.retired", { name }) })}
              />
            ) : view === "crews" ? (
              <CrewsView
                consoleMode
                tree={tr}
                onAssign={assign}
                onDone={message => setReceipt({ message })}
              />
            ) : view === "holidays" ? (
              <HolidaysView
                consoleMode
                tree={tr}
                onDone={message => setReceipt({ message })}
              />
            ) : (
              <PublicHolidaysView consoleMode />
            )}
          </div>
        ) : null
      }
      overlays={
        <>
          <AssignSheet
            targets={open && "assign" in open ? open.assign : null}
            patterns={patterns.data?.items ?? []}
            onClose={() => setOpen(null)}
            onAssigned={(layers, message) => (setOpen(null), setReceipt({ message, layer: layers[0] }))}
          />
          <PatternSheet
            open={!!open && "pattern" in open}
            onClose={() => setOpen(null)}
            onAdded={name => (setOpen(null), setReceipt({ message: t("attendancePatterns.pattern.added", { name }) }))}
          />
          <CancelLayerSheet
            layer={open && "cancel" in open ? open.cancel : null}
            onClose={() => setOpen(null)}
            onCancelled={message => (setOpen(null), setReceipt({ message }))}
          />
        </>
      }
      statusSegments={
        tr
          ? [
              { id: "view", tone: "strong", content: t(`attendance.view.${view}`) },
              { id: "people", content: t("attendance.people", { count: tr.people_total }) },
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}

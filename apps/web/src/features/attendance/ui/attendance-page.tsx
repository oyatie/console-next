import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Receipt } from "../../../ui/receipt/receipt";
import { Tabs } from "../../../ui/tabs/tabs";
import { crewsQuery, patternsQuery, treeQuery, type Layer, type ScopeKind } from "../api";
import { AttendanceHead } from "./attendance-head";
import { AssignSheet, type AssignTarget } from "./assign-sheet";
import { CalendarView } from "./calendar-view";
import { CancelLayerSheet } from "./cancel-layer-sheet";
import { CrewsView } from "./crews-view";
import { DayTab } from "./day-tab";
import { MonthTab } from "./month-tab";
import { PersonCard } from "./person-card";
import { FirstRun } from "./first-run";
import { HolidaysView } from "./holidays-view";
import { PatternSheet } from "./pattern-sheet";
import { PatternsView } from "./patterns-view";
import { PublicHolidaysView } from "./public-holidays-view";

export type View = "calendar" | "types" | "crews" | "holidays" | "public";
export type Tab = "month" | "day" | "schedule";
export type AttendanceSearch = { view?: View; kind?: ScopeKind; id?: string; month?: string; tab?: Tab; date?: string; wp?: string; unit?: string; person?: string; detail?: boolean; issues?: boolean };

const route = getRouteApi("/app/attendance");
/** What the page has open over it: one sheet at a time (no sheet over a sheet). */
type Open = { assign: AssignTarget[] } | { pattern: true } | { cancel: Layer } | null;

// Each URL-selected screen keeps its own lazy export and standing-text budget.
export function AttendancePage() {
  return <AttendanceLayout><ScheduleTab /></AttendanceLayout>;
}

export function MonthPage() {
  return <AttendanceLayout><MonthTab /></AttendanceLayout>;
}

export function DayPage() {
  return <AttendanceLayout><DayTab /></AttendanceLayout>;
}

export function PersonPage() {
  const search = route.useSearch();
  return <AttendanceLayout><PersonCard id={search.person!} month={search.month} /></AttendanceLayout>;
}

function AttendanceLayout({ children }: { children: ReactNode }) {
  const search = route.useSearch();
  return <div className="page"><AttendanceHead tab={search.tab ?? "month"} />{children}</div>;
}

/**
 * attendance › work schedule (frames A2-*, A12-first-run). The scope and month are in the URL. Every write lands with a receipt
 * that names the way back: a layer can be cancelled until its start date, after that a new layer replaces it.
 */
function ScheduleTab() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const view = search.view ?? "calendar";
  const tree = useQuery(treeQuery());
  const patterns = useQuery(patternsQuery());
  const crews = useQuery(crewsQuery());
  const [open, setOpen] = useState<Open>(null);
  const [receipt, setReceipt] = useState<{ message: string; layer?: Layer } | null>(null);
  const go = (patch: Partial<AttendanceSearch>) => void navigate({ search: (s) => ({ ...s, ...patch }) });

  const items = [
    { id: "calendar", label: t("attendance.view.calendar") },
    { id: "types", label: t("attendance.view.types"), count: patterns.data?.items.length ?? "" },
    { id: "crews", label: t("attendance.view.crews"), count: crews.data?.items.length ?? "" },
    { id: "holidays", label: t("attendance.view.holidays") },
    { id: "public", label: t("attendance.view.public") },
  ];
  // A pattern added a moment ago may still be on its way into the list (every write re-reads it): the choice between
  // the assign sheet and the pattern sheet waits for that read instead of deciding on the list from before.
  const assign = async (targets: AssignTarget[]) => {
    const list = patterns.isFetching ? (await patterns.refetch()).data : patterns.data;
    setOpen(list?.items.some((p) => p.status === "ACTIVE") ? { assign: targets } : { pattern: true });
  };

  return (
    <>
      {receipt && (
        <Receipt
          state="recorded"
          message={receipt.message}
          actions={receipt.layer && receipt.layer.state === "SCHEDULED" && <Button variant="ghost" size="sm" onClick={() => setOpen({ cancel: receipt.layer! })}>{t("attendanceSchedule.receipt.cancel")}</Button>}
        />
      )}
      <QueryState q={tree}>
        {(tr) => (
          <>
            {tr.people_unscheduled > 0 && (
              <Banner tone="warn">{t("attendanceSchedule.unscheduled.banner", { count: tr.people_unscheduled, total: tr.people_total })}</Banner>
            )}
            {!tr.holidays_loaded && <Banner tone="warn">{t("attendanceHolidays.holidays.notLoaded", { year: tr.date.slice(0, 4) })}</Banner>}
            {tr.people_total > 0 && tr.people_unscheduled === tr.people_total && !tr.nodes.some((n) => n.layer) ? (
              <FirstRun patterns={patterns.data?.items.length ?? 0} people={tr.people_total} onSchedule={() => (patterns.data?.items.length ? go({ view: "calendar" }) : setOpen({ pattern: true }))} />
            ) : null}
            <Tabs label={t("attendance.views")} items={items} selected={view} onSelect={(id) => go({ view: id as View })}>
              {(id) =>
                id === "calendar" ? (
                  <CalendarView tree={tr} search={search} onScope={(kind, scopeId) => go({ kind, id: scopeId })} onMonth={(month) => go({ month })} onAssign={assign} onCancel={(layer) => setOpen({ cancel: layer })} />
                ) : id === "types" ? (
                  <PatternsView onAdd={() => setOpen({ pattern: true })} onRetired={(name) => setReceipt({ message: t("attendancePatterns.pattern.retired", { name }) })} />
                ) : id === "crews" ? (
                  <CrewsView tree={tr} onAssign={assign} onDone={(message) => setReceipt({ message })} />
                ) : id === "holidays" ? (
                  <HolidaysView tree={tr} onDone={(message) => setReceipt({ message })} />
                ) : (
                  <PublicHolidaysView />
                )
              }
            </Tabs>
          </>
        )}
      </QueryState>
      <AssignSheet
        targets={open && "assign" in open ? open.assign : null}
        patterns={patterns.data?.items ?? []}
        onClose={() => setOpen(null)}
        onAssigned={(layers, message) => (setOpen(null), setReceipt({ message, layer: layers[0] }))}
      />
      <PatternSheet open={!!open && "pattern" in open} onClose={() => setOpen(null)} onAdded={(name) => (setOpen(null), setReceipt({ message: t("attendancePatterns.pattern.added", { name }) }))} />
      <CancelLayerSheet layer={open && "cancel" in open ? open.cancel : null} onClose={() => setOpen(null)} onCancelled={(message) => (setOpen(null), setReceipt({ message }))} />
    </>
  );
}

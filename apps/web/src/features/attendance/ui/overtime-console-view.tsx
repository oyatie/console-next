// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { useCommand } from "../../../lib/react/command";
import { Chip } from "../../../ui/chip";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { ListRecord } from "../../../ui/patterns/list-record";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import { RecordBannerBand } from "../../../ui/patterns/record-banner-band";
import { acknowledgeWeek52, week52Query, type Week52Row } from "../api";
import { dateText } from "../present";
import { AttendanceTabNav } from "./attendance-head";
import { useAttendancePhaseLine } from "./use-attendance-phase-line";
import { OvertimeAckBar } from "./overtime-ack-bar";
import { PeriodStepper } from "./period-stepper";
import { ScopePicker } from "./scope-picker";
import s from "./attendance-console.module.css";

const route = getRouteApi("/app/attendance");
const TONES = { OK: "ok", WARN: "warn", DANGER: "danger", UNKNOWN: "neutral" } as const;

const hoursLabel = (value?: number | null) =>
  value == null ? t("attendance.overtime.notReported") : t("attendance.hours", { hours: value });

export function OvertimeConsoleView({ baseline }: { baseline: () => React.ReactNode }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const date = search.date ?? todayKst();
  const board = useQuery(week52Query(date, search.wp));
  const [selectedId, setSelectedId] = useState<string>();
  const go = (patch: Record<string, unknown>) => void navigate({ search: prev => ({ ...prev, ...patch }) });

  const items = board.data?.items ?? [];
  const selectedRow = items.find(r => r.employee_id === selectedId);
  const ack = useCommand({
    run: (row: Week52Row) => acknowledgeWeek52(row.employee_id, row.week_start),
    invalidates: ["/api/v1/attendance"],
    awaitFirstRead: true,
    announce: (row) => t("attendance.overtime.ackDone", { name: row.name }),
  });
  const confirmAck = () => {
    if (selectedRow) ack.mutate(selectedRow);
  };
  const counts = {
    OK: items.filter(r => r.tone === "OK").length,
    WARN: items.filter(r => r.tone === "WARN").length,
    DANGER: items.filter(r => r.tone === "DANGER").length,
    UNKNOWN: items.filter(r => r.tone === "UNKNOWN").length,
  };

  const phaseLine = useAttendancePhaseLine();
  return (
    <ListRecord
      q={board}
      tabs={<AttendanceTabNav tab="overtime" />}
      head={{
        title: t("attendance.title"),
        titleId: "attendance-overtime-title",
        meta: phaseLine,
        asOf: board.data ? dateText(board.data.week_start) : undefined,
      }}
      filters={
        <div className={s.filterPair}>
          <PeriodStepper unit="week" variant="boxed" value={date} onChange={nextDate => go({ date: nextDate })} />
          <ScopePicker compact value={search.wp} onChange={wp => go({ wp, unit: undefined })} />
        </div>
      }
      stats={
        items.length > 0 ? (
          <StatRow
            label={t("attendance.tab.overtime")}
            items={[
              { key: "ok", label: t("attendance.overtime.OK"), value: counts.OK, tone: "ok" },
              { key: "warn", label: t("attendance.overtime.WARN"), value: counts.WARN, tone: counts.WARN > 0 ? "warn" : undefined },
              { key: "danger", label: t("attendance.overtime.DANGER"), value: counts.DANGER, tone: counts.DANGER > 0 ? "danger" : undefined },
              { key: "unknown", label: t("attendance.overtime.UNKNOWN"), value: counts.UNKNOWN, tone: "muted" },
            ]}
          />
        ) : undefined
      }
      notes={
        items.some(r => r.tone === "UNKNOWN") ? (
          <RecordBannerBand tone="warn">
            <bdi>{t("attendance.week.unknown.reason")}</bdi>
          </RecordBannerBand>
        ) : undefined
      }
      list={
        <div className={s.tableWrap}>
          <LongTable<Week52Row>
            label={t("attendance.tab.overtime")}
            rows={items}
            rowId={row => row.employee_id}
            hasMore={false}
            onLoadMore={() => {}}
            density="compact"
            mobileLayout="compact"
            activeRowId={selectedRow?.employee_id}
            onRowAction={id => setSelectedId(id)}
            empty={t("attendance.overtime.empty")}
            columns={[
              { id: "person", type: "text", header: t("attendance.col.person"), card: "title", rowHeader: true, cell: row => row.name },
              { id: "current", type: "duration", header: t("attendance.week.hours"), card: "fact", cell: row => hoursLabel(row.current_hours) },
              { id: "recognized", type: "duration", header: t("attendance.overtime.recognized"), card: "fact", cell: row => hoursLabel(row.recognized_hours) },
              { id: "overtime", type: "duration", header: t("attendance.overtime.approved"), card: "fact", cell: row => hoursLabel(row.overtime_hours) },
              {
                id: "ack",
                type: "status",
                header: t("attendance.overtime.ackCol"),
                card: "fact",
                cell: row => (
                  <Chip tone={row.acked ? "ok" : "neutral"}>
                    {t(row.acked ? "attendance.overtime.acked" : "attendance.overtime.unacked")}
                  </Chip>
                ),
              },
              {
                id: "line",
                type: "status",
                header: t("attendance.overtime.line"),
                card: "status",
                cell: row => <Chip tone={TONES[row.tone]}>{t(`attendance.overtime.${row.tone}`)}</Chip>,
              },
            ]}
          />
        </div>
      }
      onSelect={id => setSelectedId(id)}
      record={
        selectedRow
          ? {
              id: selectedRow.employee_id,
              label: t("attendance.overtime.pane.title"),
              title: t("attendance.overtime.pane.title"),
              onClose: () => setSelectedId(undefined),
              children: (
                <div className={s.paneBody}>
                  <RecordIdentityBar
                    name={selectedRow.name}
                    badges={<Chip tone={TONES[selectedRow.tone]}>{t(`attendance.overtime.${selectedRow.tone}`)}</Chip>}
                  />
                  <RecordPaneSection title={t("attendance.overtime.pane.title")}>
                    <KeyValue
                      density="dense"
                      label={t("attendance.overtime.pane.title")}
                      items={[
                        { key: "current", label: t("attendance.week.hours"), value: hoursLabel(selectedRow.current_hours) },
                        { key: "recognized", label: t("attendance.overtime.recognized"), value: hoursLabel(selectedRow.recognized_hours) },
                        { key: "overtime", label: t("attendance.overtime.approved"), value: hoursLabel(selectedRow.overtime_hours) },
                        { key: "projected", label: t("me.attendance.week52.projected"), value: hoursLabel(selectedRow.projected_hours) },
                        {
                          key: "ack",
                          label: t("attendance.overtime.ackCol"),
                          value: (
                            <Chip tone={selectedRow.acked ? "ok" : "neutral"}>
                              {t(selectedRow.acked ? "attendance.overtime.acked" : "attendance.overtime.unacked")}
                            </Chip>
                          ),
                        },
                      ]}
                    />
                  </RecordPaneSection>
                  <OvertimeAckBar
                    row={selectedRow}
                    date={date}
                    wp={search.wp}
                    pending={ack.isPending}
                    error={ack.error}
                    onAck={confirmAck}
                  />
                </div>
              ),
            }
          : null
      }
      statusSegments={
        board.data
          ? [
              {
                id: "summary",
                content: t("attendance.overtime.status.summary", {
                  week: dateText(board.data.week_start),
                  count: items.length,
                }),
              },
              ...(selectedRow ? [{ id: "selected", tone: "strong" as const, content: selectedRow.name }] : []),
            ]
          : undefined
      }
      baseline={baseline}
    />
  );
}

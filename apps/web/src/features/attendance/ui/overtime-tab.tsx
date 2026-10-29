// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { LongTable } from "../../../ui/long-table/long-table";
import { week52Query, type Week52Row } from "../api";
import { dateText } from "../present";
import { ReadPeriod } from "./read-period";

const route = getRouteApi("/app/attendance");
const tones = { OK: "ok", WARN: "warn", DANGER: "danger", UNKNOWN: "neutral" } as const;
const hours = (value?: number) => value === undefined ? t("attendance.overtime.notReported") : t("attendance.hours", { hours: value });
export function OvertimeTab() {
  const search = route.useSearch();
  const board = useQuery(week52Query(search.date ?? todayKst(), search.wp));
  return <><ReadPeriod week /><QueryState q={board} layout="list">{data => <>
    <h2>{t("attendance.overtime.heading", { date: dateText(data.week_start) })}</h2>
    <LongTable<Week52Row> label={t("attendance.tab.overtime")} rows={data.items} rowId={row => row.employee_id} hasMore={false} onLoadMore={() => {}}
      empty={t("attendance.overtime.empty")} columns={[
        { id: "person", header: t("attendance.col.person"), card: "title", rowHeader: true, cell: row => row.name },
        { id: "recognized", header: t("attendance.overtime.recognized"), card: "fact", cell: row => hours(row.recognized_hours) },
        { id: "overtime", header: t("attendance.overtime.approved"), card: "fact", cell: row => hours(row.overtime_hours) },
        { id: "line", header: t("attendance.overtime.line"), card: "status", cell: row => <Chip tone={tones[row.tone]}>{t(`attendance.overtime.${row.tone}`)}</Chip> },
      ]} />
  </>}</QueryState></>;
}

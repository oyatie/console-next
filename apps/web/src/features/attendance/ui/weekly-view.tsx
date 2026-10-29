// SPDX-License-Identifier: LicenseRef-Proprietary
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { QueryState } from "../../../lib/react/query-state";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { addDays, isDate, nextMonday } from "../../../ui/date/days";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { weeklyQuery } from "../api";
import { dateText } from "../present";

const route = getRouteApi("/app/attendance");

export function WeeklyView() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const date = search.date && isDate(search.date) ? search.date : todayKst();
  const week = addDays(nextMonday(date), -7);
  const q = useQuery({ ...weeklyQuery(week), placeholderData: keepPreviousData });
  const go = (days: number) => void navigate({ search: s => ({ ...s, date: addDays(week, days) }) });
  return <Card title={t("attendance.week.title")} meta={`${dateText(week)} – ${dateText(addDays(week, 6))}`} tools={<>
    <Button size="sm" onClick={() => go(-7)}>{t("attendance.week.previous")}</Button>
    <Button size="sm" onClick={() => go(7)}>{t("attendance.week.next")}</Button>
  </>}>
    <QueryState q={q} layout="list" empty={d => d.items.length ? null : <EmptyState title={t("attendance.week.empty")} reason={t("attendance.week.empty.reason")} />}>
      {d => <>
        {d.items.some(r => r.tone === "UNKNOWN") && <Banner tone="info">{t("attendance.week.unknown.reason")}</Banner>}
        <Table label={t("attendance.week.title")} rows={d.items} rowId={r => r.employee_id} columns={[
          { header: t("attendance.week.person"), type: "text", card: "title", rowHeader: true, cell: r => r.name },
          { header: t("attendance.week.hours"), type: "duration", cell: r => t("attendance.week.hours.value", { hours: r.current_hours }) },
          { header: t("attendance.week.state"), type: "status", card: "status", cell: r => r.tone === "UNKNOWN"
            ? <Chip tone="neutral">{t("attendance.week.UNKNOWN")}</Chip>
            : <Chip tone={r.tone === "DANGER" ? "danger" : r.tone === "WARN" ? "warn" : "ok"}>{t(`attendance.week.${r.tone}`)}</Chip> },
        ]} />
      </>}
    </QueryState>
  </Card>;
}

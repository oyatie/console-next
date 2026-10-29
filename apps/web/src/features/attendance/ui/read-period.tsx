// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { IconButton } from "../../../ui/button/button";
import { addDays } from "../../../ui/date/days";
import { shiftMonth } from "../domain/month";
import { dateText, monthText } from "../present";
import { ScopePicker } from "./scope-picker";
import s from "./attendance.module.css";

const route = getRouteApi("/app/attendance");
/** Period and workplace remain usable above the read boundary, including a refused read. */
export function ReadPeriod({ week = false }: { week?: boolean }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const date = search.date ?? todayKst();
  const month = search.month ?? date.slice(0, 7);
  const move = (step: number) => void navigate({ search: s => ({ ...s, ...(week ? { date: addDays(date, step * 7) } : { month: shiftMonth(month, step) }) }) });
  return <div className={s.toolbar}>
    <ScopePicker value={search.wp} onChange={wp => void navigate({ search: s => ({ ...s, wp, unit: undefined }) })} />
    <IconButton label={t(week ? "attendance.week.prev" : "attendanceRecords.toolbar.prevMonth")} onClick={() => move(-1)}><ChevronLeft size={16} aria-hidden /></IconButton>
    <strong>{week ? dateText(date) : monthText(month)}</strong>
    <IconButton label={t(week ? "attendance.week.next" : "attendanceRecords.toolbar.nextMonth")} onClick={() => move(1)}><ChevronRight size={16} aria-hidden /></IconButton>
  </div>;
}

// SPDX-License-Identifier: LicenseRef-Proprietary
import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { Button, IconButton } from "../../../ui/button/button";
import { addDays, nextMonday } from "../../../ui/date/days";
import { shiftMonth } from "../domain/month";
import { dateText, dayText, monthText } from "../present";
import s from "./period-stepper.module.css";

const labels = {
  day: ["attendanceRecords.toolbar.prevDay", "attendanceRecords.toolbar.nextDay", "uiDate.today"],
  week: ["attendance.week.prev", "attendance.week.next", "attendance.period.thisWeek"],
  month: ["attendanceRecords.toolbar.prevMonth", "attendanceRecords.toolbar.nextMonth", "attendance.period.thisMonth"],
  year: ["attendanceHolidays.year.prev", "attendanceHolidays.year.next", "attendance.period.thisYear"],
} as const;

/** Controlled business period; callers retain their own scope, URL and unsaved-change behaviour. */
export function PeriodStepper({ unit, value, onChange }: { unit: keyof typeof labels; value: string; onChange: (value: string) => void }) {
  const today = todayKst();
  const current = unit === "month" ? today.slice(0, 7) : unit === "year" ? today.slice(0, 4) : today;
  const start = unit === "week" ? addDays(nextMonday(value), -7) : value;
  const text = unit === "week" ? `${dayText(start)} – ${dayText(addDays(start, 6))}`
    : unit === "month" ? monthText(value) : unit === "year" ? t("attendanceHolidays.year", { year: value }) : dateText(value);
  const move = (step: number) => onChange(unit === "month" ? shiftMonth(value, step)
    : unit === "year" ? String(Number(value) + step) : addDays(value, step * (unit === "week" ? 7 : 1)));
  return <div className={s.controls} role="group" aria-label={t("attendance.period.label")}>
    <div className={s.stepper}>
      <IconButton size="sm" label={t(labels[unit][0])} onClick={() => move(-1)}><ChevronLeft size={16} aria-hidden /></IconButton>
      <strong className={s.text}>{text}</strong>
      <IconButton size="sm" label={t(labels[unit][1])} onClick={() => move(1)}><ChevronRight size={16} aria-hidden /></IconButton>
    </div>
    <Button size="sm" variant="ghost" onClick={() => onChange(current)}>{t(labels[unit][2])}</Button>
  </div>;
}

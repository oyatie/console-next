// SPDX-License-Identifier: LicenseRef-Proprietary
import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtMonth } from "@console/i18n/format";
import { todayKst } from "../../lib/pure/today";
import { Button, IconButton } from "../button/button";
import { addDays, nextMonday, shiftMonth } from "../date/days";
import s from "./period-stepper.module.css";

const labels = {
  day: ["attendanceRecords.toolbar.prevDay", "attendanceRecords.toolbar.nextDay", "uiDate.today"],
  week: ["attendance.week.prev", "attendance.week.next", "attendance.period.thisWeek"],
  month: ["attendanceRecords.toolbar.prevMonth", "attendanceRecords.toolbar.nextMonth", "attendance.period.thisMonth"],
  year: ["attendanceHolidays.year.prev", "attendanceHolidays.year.next", "attendance.period.thisYear"],
} as const;

/** Calendar granularity stepped by PeriodStepper. */
export type PeriodUnit = keyof typeof labels;

export type PeriodStepperProps = {
  /** Calendar granularity stepped by prev/next and current-period jump. */
  unit: PeriodUnit;
  /** Current business period (`YYYY-MM-DD`, `YYYY-MM`, or `YYYY`). */
  value: string;
  /** Called with the shifted or current ISO period string. */
  onChange: (value: string) => void;
  /** Visual chrome: `plain` (inline chevrons) or `boxed` (unified bordered control). */
  variant?: "plain" | "boxed";
  /** Show the quick-jump button (`today` / `this week` / `this month` / `this year`). */
  showCurrent?: boolean;
  /** Accessible group label override (defaults to `attendance.period.label`). */
  label?: string;
};

/** Controlled business period; callers retain their own scope, URL and unsaved-change behaviour. */
export function PeriodStepper({
  unit,
  value,
  onChange,
  variant = "plain",
  showCurrent = true,
  label,
}: PeriodStepperProps) {
  const today = todayKst();
  const current = unit === "month" ? today.slice(0, 7) : unit === "year" ? today.slice(0, 4) : today;
  const start = unit === "week" ? addDays(nextMonday(value), -7) : value;
  const text = unit === "week" ? `${fmtDate(start)} – ${fmtDate(addDays(start, 6))}`
    : unit === "month" ? fmtMonth(value)
    : unit === "year" ? t("attendanceHolidays.year", { year: value })
    : fmtDate(value, { weekday: "short" });
  const move = (step: number) => onChange(unit === "month" ? shiftMonth(value, step)
    : unit === "year" ? String(Number(value) + step)
    : addDays(value, step * (unit === "week" ? 7 : 1)));

  return (
    <div className={s.controls} role="group" aria-label={label ?? t("attendance.period.label")}>
      <div className={s.stepper} data-variant={variant}>
        <IconButton size="sm" className={s.stepBtn} label={t(labels[unit][0])} onClick={() => move(-1)}>
          <ChevronLeft size={16} aria-hidden />
        </IconButton>
        <strong className={s.text}>{text}</strong>
        <IconButton size="sm" className={s.stepBtn} label={t(labels[unit][1])} onClick={() => move(1)}>
          <ChevronRight size={16} aria-hidden />
        </IconButton>
      </div>
      {showCurrent && (
        <Button size="sm" variant="ghost" onClick={() => onChange(current)}>
          {t(labels[unit][2])}
        </Button>
      )}
    </div>
  );
}

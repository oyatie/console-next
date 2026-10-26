// SPDX-License-Identifier: LicenseRef-Proprietary
import { parseDate } from "@internationalized/date";
import { t } from "@console/i18n";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button, Calendar, CalendarCell, CalendarGrid, CalendarHeading } from "react-aria-components";
import s from "./date-calendar.module.css";

/** Loaded on calendar intent; typed date entry stays independent of the calendar. */
export function DateCalendar({ value, focused, min, max, blocked, onPick }: {
  value?: string;
  focused: string;
  min?: string;
  max?: string;
  blocked: ReadonlySet<string>;
  onPick: (date: string) => void;
}) {
  return (
    // oxlint-disable-next-line jsx-a11y/no-autofocus -- Opening the calendar explicitly must focus its selected day after loading.
    <Calendar autoFocus
      aria-label={t("uiDate.calendar.label")}
      value={value ? parseDate(value) : null}
      defaultFocusedValue={parseDate(focused)}
      minValue={min ? parseDate(min) : undefined}
      maxValue={max ? parseDate(max) : undefined}
      isDateUnavailable={(date) => blocked.has(date.toString())}
      onChange={(date) => date && onPick(date.toString())}
      className={s.calendar}
    >
      <header className={s.calendarHeader}>
        <Button slot="previous" type="button" className={s.monthButton} aria-label={t("uiDate.calendar.previous")}><ChevronLeft size={18} aria-hidden /></Button>
        <CalendarHeading className={s.monthHeading} />
        <Button slot="next" type="button" className={s.monthButton} aria-label={t("uiDate.calendar.next")}><ChevronRight size={18} aria-hidden /></Button>
      </header>
      <CalendarGrid className={s.grid} weekdayStyle="short">
        {(date) => <CalendarCell date={date} className={s.calendarDay} />}
      </CalendarGrid>
    </Calendar>
  );
}

import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "@console/i18n";
import { IconButton } from "../../../ui/button/button";
import s from "./attendance.module.css";

/** One year back or forward (public holiday · company holiday lists). */
export function YearStepper({ year, onYear }: { year: number; onYear: (y: number) => void }) {
  return (
    <span className={s.toolbar}>
      <IconButton size="sm" label={t("attendanceHolidays.year.prev")} onClick={() => onYear(year - 1)}><ChevronLeft size={16} aria-hidden /></IconButton>
      <strong className="num">{t("attendanceHolidays.year", { year })}</strong>
      <IconButton size="sm" label={t("attendanceHolidays.year.next")} onClick={() => onYear(year + 1)}><ChevronRight size={16} aria-hidden /></IconButton>
    </span>
  );
}

import { CalendarDays, Lock } from "lucide-react";
import { Chip } from "../chip";
import s from "./page-head.module.css";

/**
 * The head's as-of date (design-language §4.3) while only today is served: the date the view reads as of, marked today and
 * locked, with why (`locked`) as its tooltip and for assistive tech. It looks like the control it will become, not pressable.
 */
export function AsOf({ label, date, today, locked }: { label: string; date: string; today: string; locked: string }) {
  return (
    <span className={s.asof} aria-disabled="true" title={locked}>
      <CalendarDays size={16} aria-hidden />{label} <b className={s.asofDate}>{date}</b><Chip>{today}</Chip><Lock size={12} aria-hidden />
      <span className="sr-only">{locked}</span>
    </span>
  );
}

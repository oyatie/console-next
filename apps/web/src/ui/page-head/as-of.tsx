import { CalendarDays } from "lucide-react";
import { Chip } from "../chip";
import s from "./page-head.module.css";

/** The date this view reads, displayed as a fact rather than an unavailable date control. */
export function AsOf({ label, date, today }: { label: string; date: string; today: string }) {
  return (
    <span className={s.asof}>
      <CalendarDays size={16} aria-hidden />{label} <b className={s.asofDate}>{date}</b><Chip>{today}</Chip>
    </span>
  );
}

import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { nextMonday, nextMonthFirst, type Typed } from "./days";

/** The long date, with its weekday unless `weekday` is false: year-month-day (weekday) in Korean, "Mon, October 12, 2026" in English. */
export function fmtLongDay(d: string, weekday = true) {
  return fmtDate(d, weekday ? { weekday: "short" } : undefined);
}

/** Why typed text is not a date, or null when it is one (or nothing was typed). */
export function typedProblem(p: Typed): string | null {
  if ("date" in p || "empty" in p) return null;
  return p.bad === "month" ? t("uiDate.bad.month", { month: p.month }) : p.bad === "day" ? t("uiDate.bad.day", { month: p.month, day: p.day }) : t("uiDate.bad.format");
}


const PRESET = { today: (d: string) => d, nextMonday, nextMonthFirst } as const;
/** The common date chips (today, next Monday, the 1st of next month), each resolved from `today`, in the order asked. */
export const datePresets = (today: string, kinds: readonly (keyof typeof PRESET)[]) =>
  kinds.map((k) => ({ label: t(`uiDate.preset.${k}`), date: PRESET[k](today) }));

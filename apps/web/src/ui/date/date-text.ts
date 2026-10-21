import { i18n, t } from "@console/i18n";
import { nextMonday, nextMonthFirst, utc, type Typed } from "./days";

/** The long date, with its weekday unless `weekday` is false: year-month-day (weekday) in Korean, "Mon, October 12, 2026" in English. */
export function fmtLongDay(d: string, weekday = true) {
  const ko = i18n.locale === "ko";
  const date = new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" }).format(utc(d));
  if (!weekday) return date;
  const wd = new Intl.DateTimeFormat(ko ? "ko-KR" : "en-US", { timeZone: "UTC", weekday: "short" }).format(utc(d));
  return ko ? `${date} (${wd})` : `${wd}, ${date}`;
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

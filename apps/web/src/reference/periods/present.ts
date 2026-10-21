import { i18n, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { PERIOD_LOCK_DOMAIN, label } from "../../lib/labels";
import { wholeMonth, type Window } from "./domain/window";

/** A `YYYY-MM` month or `YYYY-MM-DD` day in the UI language, by `options`. */
export const dayFormat = (options: Intl.DateTimeFormatOptions) => (d: string) =>
  new Intl.DateTimeFormat(i18n.locale === "ko" ? "ko-KR" : "en-US", { timeZone: "UTC", ...options }).format(new Date(`${d.length === 7 ? `${d}-15` : d}T00:00:00Z`));
/** A `YYYY-MM` month by name, e.g. "September 2026" in English. */
export const monthText = dayFormat({ year: "numeric", month: "long" });

export const domainText = (d: string) => label(PERIOD_LOCK_DOMAIN, d);

/** The month name for a whole month, else the date range. */
export const periodText = (w: Window) => {
  const month = wholeMonth(w);
  return month ? monthText(month) : t("periodLocks.period", { from: fmtDate(w.periodStart), to: fmtDate(w.periodEnd) });
};

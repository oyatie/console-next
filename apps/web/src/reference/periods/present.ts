import { t } from "@console/i18n";
import { fmtDate, fmtMonth } from "@console/i18n/format";
import { PERIOD_LOCK_DOMAIN, label } from "../../lib/labels";
import { wholeMonth, type Window } from "./domain/window";

/** A month label with its year. */
export const monthText = (d: string) => fmtMonth(d);

export const domainText = (d: string) => label(PERIOD_LOCK_DOMAIN, d);

/** The month name for a whole month, else the date range. */
export const periodText = (w: Window) => {
  const month = wholeMonth(w);
  return month ? monthText(month) : t("periodLocks.period", { from: fmtDate(w.periodStart), to: fmtDate(w.periodEnd) });
};

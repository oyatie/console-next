// Period windows on `YYYY-MM-DD` business dates, shared by the lock page and Home.

export type Window = { periodStart: string; periodEnd: string };

/** `YYYY-MM` → its first and last day. */
export function monthWindow(month: string): Window {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { periodStart: `${month}-01`, periodEnd: `${month}-${String(last).padStart(2, "0")}` };
}

/** The whole month a window covers, or null when it is any other range. */
export function wholeMonth(w: Window): string | null {
  const month = w.periodStart.slice(0, 7);
  const mw = monthWindow(month);
  return mw.periodStart === w.periodStart && mw.periodEnd === w.periodEnd ? month : null;
}


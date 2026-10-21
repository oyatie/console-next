// Display formatters. Business time is Asia/Seoul regardless of the viewer's clock; the
// language of dates and numbers follows the UI locale.
import { i18n, t } from "./index";

const TZ = "Asia/Seoul";
const INTL_LOCALE = { ko: "ko-KR", en: "en-US" } as const;
const cache = new Map<string, { date: Intl.DateTimeFormat; dateTime: Intl.DateTimeFormat; dateTimeShort: Intl.DateTimeFormat; time: Intl.DateTimeFormat; number: Intl.NumberFormat }>();
const fmt = () => {
  const tag = INTL_LOCALE[i18n.locale];
  let f = cache.get(tag);
  if (!f)
    cache.set(
      tag,
      (f = {
        date: new Intl.DateTimeFormat(tag, { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }),
        dateTime: new Intl.DateTimeFormat(tag, { timeZone: TZ, dateStyle: "short", timeStyle: "short" }),
        dateTimeShort: new Intl.DateTimeFormat(tag, { timeZone: TZ, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
        time: new Intl.DateTimeFormat(tag, { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
        number: new Intl.NumberFormat(tag),
      }),
    );
  return f;
};

/** Parse an RFC 3339 backend timestamp. */
export function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const fmtDate = (v: unknown) => {
  const d = typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00+09:00`) : parseTimestamp(v);
  return d ? fmt().date.format(d) : "—";
};
export const fmtDateTime = (v: unknown) => {
  const d = parseTimestamp(v);
  return d ? fmt().dateTime.format(d) : "—";
};
/** Month, day and 24-hour time in Seoul, no year: a recent moment in a dense row (잠금 시각, 기록 시각). */
export const fmtDateTimeShort = (v: unknown) => {
  const d = parseTimestamp(v);
  return d ? fmt().dateTimeShort.format(d) : "—";
};
/** The full date and 24-hour time in Seoul, as a ledger's 기록일시 column reads it (2026. 10. 02. 16:40). */
export const fmtStamp = (v: unknown) => {
  const d = parseTimestamp(v);
  return d ? `${fmt().date.format(d)} ${fmt().time.format(d)}` : "—";
};
export const fmtNumber = (n: number) => fmt().number.format(n);
/** Money arrives as a decimal string; never coerce a missing value to 0. */
export const fmtKrw = (v: string | null | undefined) =>
  v == null || v === "" ? t("format.notComputable") : t("format.krw", { amount: Number(v) });

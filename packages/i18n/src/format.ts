// Display formats are fixed to the app language and Korean business time, never the browser locale.
import { i18n, t, type Locale } from "./index";

const TZ = "Asia/Seoul";
const INTL_LOCALE: Record<Locale, string> = { ko: "ko-KR", en: "en-US" };
type Formatters = {
  date: Intl.DateTimeFormat;
  weekdayShort: Intl.DateTimeFormat;
  weekdayLong: Intl.DateTimeFormat;
  dateTime: Intl.DateTimeFormat;
  month: Intl.DateTimeFormat;
  monthShort: Intl.DateTimeFormat;
  number: Intl.NumberFormat;
};
const cache = new Map<Locale, Formatters>();
const fmt = () => {
  const locale = i18n.locale;
  let f = cache.get(locale);
  if (!f) {
    const tag = INTL_LOCALE[locale];
    cache.set(
      locale,
      (f = {
        date: new Intl.DateTimeFormat(tag, { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }),
        weekdayShort: new Intl.DateTimeFormat(tag, { timeZone: TZ, weekday: "short" }),
        weekdayLong: new Intl.DateTimeFormat(tag, { timeZone: TZ, weekday: "long" }),
        dateTime: new Intl.DateTimeFormat(tag, { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
        month: new Intl.DateTimeFormat(tag, { timeZone: "UTC", year: "numeric", month: "long" }),
        monthShort: new Intl.DateTimeFormat(tag, { timeZone: "UTC", year: "numeric", month: "short" }),
        number: new Intl.NumberFormat(tag),
      }),
    );
  }
  return f;
};

const dateOnly = (value: string): Date | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(`${value}T00:00:00+09:00`);
};

/** Parse an RFC 3339 backend timestamp. */
export function parseTimestamp(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

type DateFormatOptions = { weekday?: "short" | "long" };

/** A business date as YYYY. MM. DD. in Korean or a localized English date, optionally with its weekday. */
export function fmtDate(v: unknown, options: DateFormatOptions = {}) {
  const d = typeof v === "string" ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? dateOnly(v) : parseTimestamp(v)) : null;
  if (!d) return "—";
  const date = fmt().date.format(d);
  if (!options.weekday) return date;
  const weekday = (options.weekday === "long" ? fmt().weekdayLong : fmt().weekdayShort).format(d);
  return i18n.locale === "ko" ? `${date} (${weekday})` : `${weekday}, ${date}`;
}

/** A month label with its year, for a YYYY-MM business month. */
export function fmtMonth(v: unknown, style: "long" | "short" = "long") {
  if (typeof v !== "string" || !/^\d{4}-\d{2}$/.test(v)) return "—";
  if (Number(v.slice(5, 7)) < 1 || Number(v.slice(5, 7)) > 12) return "—";
  const d = new Date(`${v}-15T00:00:00Z`);
  return (style === "short" ? fmt().monthShort : fmt().month).format(d);
}

/** A weekday label for a business date. */
export function fmtWeekday(v: unknown, style: "short" | "long" = "short") {
  const d = typeof v === "string" ? dateOnly(v) : null;
  return d ? (style === "long" ? fmt().weekdayLong : fmt().weekdayShort).format(d) : "—";
}

/** The keyboard format of a date field, independent of the browser's language. */
export function fmtDateInput(v: unknown) {
  if (typeof v !== "string" || !dateOnly(v)) return "";
  const [year, month, day] = v.split("-");
  return i18n.locale === "ko" ? `${year}. ${month}. ${day}.` : `${month}/${day}/${year}`;
}

/** A timestamp in Korean business time; every display includes the KST zone label. */
export function fmtDateTime(v: unknown) {
  const d = parseTimestamp(v);
  return d ? `${fmt().dateTime.format(d)} KST` : "—";
}

/** Compatibility export for callers owned by other lanes. */
export const fmtDateTimeShort = fmtDateTime;

export const fmtNumber = (n: number) => fmt().number.format(n);
/** Money arrives as a decimal string; never coerce a missing value to 0. */
export const fmtKrw = (v: string | null | undefined) =>
  v == null || v === "" ? t("format.notComputable") : t("format.krw", { amount: Number(v) });

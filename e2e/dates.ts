import { kstDate } from "./flows";

/** How the employee page writes a business date in sentences and its next box ("11월 2일 (월)"; the year only when not this year). */
export const koDay = (ymd: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "UTC", year: ymd.slice(0, 4) === kstDate().slice(0, 4) ? undefined : "numeric", month: "long", day: "numeric", weekday: "short" })
    .format(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10))));

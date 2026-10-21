import { koDate } from "./flows";

/** A business date with its weekday, as employee sentences and the next-record box show it. */
export const koDay = (ymd: string) =>
  `${koDate(ymd)} (${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date(`${ymd}T00:00:00+09:00`))})`;

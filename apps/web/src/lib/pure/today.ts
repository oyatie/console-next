/** Business time is Asia/Seoul regardless of the viewer's clock. */
const pad = (n: number) => String(n).padStart(2, "0");

/** Today's calendar date in Korea as YYYY-MM-DD. */
export const todayKst = (now = new Date()) => {
  const date = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

/** Normalizes an ISO date or timestamp into a KST calendar day (`YYYY-MM-DD`). */
export function kstDayIso(iso: string | undefined | null): string | null {
  if (!iso) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  return todayKst(new Date(parsed));
}

/** Extracts `MM-DD` in KST from an ISO date or timestamp. */
export function shortMonthDay(iso: string | undefined | null): string | null {
  const day = kstDayIso(iso);
  return day ? day.slice(5) : null;
}

/** Business time is Asia/Seoul regardless of the viewer's clock. */
const TZ = "Asia/Seoul";

/** Today's calendar date in Korea as YYYY-MM-DD (en-CA formats ISO order). */
export const todayKst = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

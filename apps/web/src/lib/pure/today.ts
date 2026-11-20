/** Business time is Asia/Seoul regardless of the viewer's clock. */
const pad = (n: number) => String(n).padStart(2, "0");

/** Today's calendar date in Korea as YYYY-MM-DD. */
export const todayKst = (now = new Date()) => {
  const date = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
};

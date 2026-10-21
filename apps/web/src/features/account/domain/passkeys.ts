import type { components } from "@console/api/schema";

type Passkey = components["schemas"]["PasskeySummary"];

/**
 * A passkey row as the screen tells it apart: the server keeps no name or device, so a passkey is
 * named by its registration day (KST). `nth` numbers passkeys registered on the same day (1-based, by
 * registration time) and is 0 when the day is unique, so deleting one never renumbers another day's.
 * `recent` marks the most recently used of several.
 */
export type PasskeyRow = Passkey & { day: string; nth: number; recent: boolean };

const KST_MS = 9 * 60 * 60 * 1000;
/** The Asia/Seoul calendar day of an RFC 3339 timestamp, as YYYY-MM-DD. */
export const kstDay = (ts: string) => new Date(Date.parse(ts) + KST_MS).toISOString().slice(0, 10);

export function passkeyRows(list: readonly Passkey[]): PasskeyRow[] {
  const sorted = [...list].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const perDay = new Map<string, number>();
  for (const p of sorted) {
    const day = kstDay(p.created_at);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const used = sorted.filter((p) => p.last_used_at).map((p) => Date.parse(p.last_used_at!));
  const latest = sorted.length > 1 && used.length ? Math.max(...used) : null;
  const seen = new Map<string, number>();
  return sorted.map((p) => {
    const day = kstDay(p.created_at);
    const n = (seen.get(day) ?? 0) + 1;
    seen.set(day, n);
    return { ...p, day, nth: perDay.get(day)! > 1 ? n : 0, recent: latest !== null && p.last_used_at !== null && Date.parse(p.last_used_at) === latest };
  });
}

// The period-lock calendar (governance-39): each domain's finished months, oldest first, as locked, open until an
// automatic re-lock, or open. Pure: the locks come from the server's list, newest first.
import { inForce, monthWindow, recentMonths, type Lock } from "./period";

export type StripLock = Lock & { relockAt?: string };
export type MonthCell<L extends StripLock> =
  | { month: string; state: "locked"; lock: L }
  | { month: string; state: "unlocked"; lock: L; relockAt: string }
  | { month: string; state: "open" };

const touches = (l: Lock, month: string) => {
  const w = monthWindow(month);
  return l.periodStart <= w.periodEnd && l.periodEnd >= w.periodStart;
};

/**
 * One domain's months: a lock in force touching the month locks it; otherwise the newest unlock with a time box
 * leaves it open until that box ends; otherwise it is open.
 */
export function monthStrip<L extends StripLock>(locks: readonly L[], domain: string, today: string, n = 12): MonthCell<L>[] {
  return recentMonths(today, n)
    .reverse()
    .map((month) => {
      const mine = locks.filter((l) => l.domain === domain && touches(l, month));
      const locked = mine.find(inForce);
      if (locked) return { month, state: "locked", lock: locked };
      const unlocked = mine.find((l) => l.unlockedAt && l.relockAt);
      return unlocked?.relockAt ? { month, state: "unlocked", lock: unlocked, relockAt: unlocked.relockAt } : { month, state: "open" };
    });
}

/** Days until an automatic re-lock, counted up (D-1: it locks again within a day); never negative. */
export const daysLeft = (relockAt: string, now: number) => Math.max(0, Math.ceil((Date.parse(relockAt) - now) / 86_400_000));

/** The cell a key moves to in a grid of `rows` × `cols` (arrows, Home, End), or null for any other key. */
export function step(key: string, at: { row: number; col: number }, rows: number, cols: number): { row: number; col: number } | null {
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max - 1);
  switch (key) {
    case "ArrowLeft": return { row: at.row, col: clamp(at.col - 1, cols) };
    case "ArrowRight": return { row: at.row, col: clamp(at.col + 1, cols) };
    case "ArrowUp": return { row: clamp(at.row - 1, rows), col: at.col };
    case "ArrowDown": return { row: clamp(at.row + 1, rows), col: at.col };
    case "Home": return { row: at.row, col: 0 };
    case "End": return { row: at.row, col: cols - 1 };
    default: return null;
  }
}

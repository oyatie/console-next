// The apply job a screen started (r3:hire-02, EMP-E12-jobs): which run it is, kept in this browser so leaving the
// import and coming back re-attaches to the job instead of offering the apply again. Per-viewer convenience only: the
// job itself is the server's (GET …/apply). Storage may be missing or throw (private window): then nothing is kept.
import type { ApplyJob } from "./contract";

const KEY = "console.import.applyJob";

export type Kept = { runId: string; digest: string };

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
const browser = () => (globalThis as { localStorage?: Store }).localStorage as Store;

export function keepJob(k: Kept | null, store: () => Store = browser) {
  try {
    if (k) store().setItem(KEY, JSON.stringify(k));
    else store().removeItem(KEY);
  } catch {
    // no storage: the job is only followed while the screen is open
  }
}

export function keptJob(store: () => Store = browser): Kept | null {
  try {
    const v = JSON.parse(store().getItem(KEY) ?? "null") as Partial<Kept> | null;
    return v && typeof v.runId === "string" && typeof v.digest === "string" ? { runId: v.runId, digest: v.digest } : null;
  } catch {
    return null;
  }
}

/** Still being written: the screen follows it (and may be left). */
export const running = (j: ApplyJob) => j.state === "queued" || j.state === "applying" || j.state === "settling";

/** How far the job is, as a share of the rows it settles (0 until the settle starts counting). */
export const share = (j: ApplyJob) => (j.state === "done" ? 1 : j.total > 0 ? Math.min(1, j.done / j.total) : 0);

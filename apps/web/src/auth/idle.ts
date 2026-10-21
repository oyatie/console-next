// The server enforces the idle timeout. This module reports user activity and computes the warning shown by IdleGuard.
import type { QueryClient } from "@tanstack/react-query";
import { api, lastReported, lastTouch, session, touch } from "@console/api";
import { syncDraftPrincipal } from "../lib/react/use-draft";

export const IDLE_KEY = "auth.idle_timeout_minutes";
/** The server remains authoritative for expiry. */
export const WARN_LEAD_MS = 2 * 60_000;

/** Only trusted input triggers reports; no timer keeps an idle tab alive. */
export const ACTIVITY_REPORT_MS = 60_000;

const SHARED_KEY = "console.lastInteraction";
const SHARE_EVERY_MS = 5_000;

export function lastActive(): number | null {
  let shared = 0;
  try {
    shared = Number(localStorage.getItem(SHARED_KEY)) || 0;
  } catch {
    // Storage blocked: this tab's own input still counts.
  }
  return Math.max(lastTouch() ?? 0, shared) || null;
}

export const IDLE_EXPIRED = "session_idle_expired";

export function idleCutoff(last: number | null, timeoutMs: number | null, now: number, lead = WARN_LEAD_MS): number | "ended" | null {
  if (last === null || timeoutMs === null) return null;
  const at = last + timeoutMs;
  return now >= at ? "ended" : now >= at - lead ? at : null;
}

/** Keep the same user's drafts after expiry; reload after another user signs in so cached data cannot cross accounts. */
export function watchSession(qc: QueryClient, signedOut: () => void) {
  const channel = typeof window !== "undefined" && typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("console.session") : null;
  channel?.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
    if (!data || typeof data !== "object" || !("previous" in data) || !("principal" in data)) return;
    if (data.principal === null && data.previous === session.principal) session.expire("session_signed_out_elsewhere");
    else if (typeof data.principal === "string" && session.principal !== null && data.principal !== session.principal) session.set(null);
  });
  let shared = 0;
  const onInput = (e: Event) => {
    if (!e.isTrusted) return;
    const now = Date.now();
    touch(now);
    if (session.token && session.stage === "app" && !session.lost && now - lastReported() >= ACTIVITY_REPORT_MS) void api.GET("/api/v1/users/me").catch(() => undefined);
    if (now - shared < SHARE_EVERY_MS) return;
    shared = now;
    try {
      localStorage.setItem(SHARED_KEY, String(now));
    } catch {
      // Storage blocked: only cross-tab warnings are affected.
    }
  };
  for (const type of ["pointerdown", "keydown", "touchstart"]) document.addEventListener(type, onInput, { capture: true, passive: true });

  let principal: string | null = null;
  let wasLost = false;
  session.subscribe(() => {
    if (session.lost) return void (wasLost = true);
    const next = session.token ? session.principal : null;
    // A cold refused refresh has not identified anyone; only a known account or its explicit sign-out decides ownership.
    if (next !== null || principal !== null) syncDraftPrincipal(next);
    const resumed = wasLost;
    wasLost = false;
    if (next !== principal) {
      channel?.postMessage({ previous: principal, principal: next });
      const replaced = principal !== null && next !== null;
      principal = next;
      qc.clear();
      if (replaced) return location.assign(session.claims?.platform ? "/platform" : "/");
      if (!next) signedOut();
    } else if (resumed && next) void qc.invalidateQueries();
  });
}

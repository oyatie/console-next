import { lazy, Suspense, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, refresh, session } from "@console/api";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { chunk } from "../lib/chunk-guard";
import { get } from "../lib/query";
import { Banner } from "../ui/banner/banner";
import { Button } from "../ui/button/button";
import { IDLE_KEY, idleCutoff, lastActive, WARN_LEAD_MS } from "./idle";
import s from "./idle.module.css";

// The dialog (React Aria's modal) is its own chunk: the initial load carries only the warning.
const ReAuth = lazy(() => chunk(import("./ReAuth")));

/** Input that can move the last-input time while the warning shows (or before the first input). */
const INPUT = ["pointerdown", "keydown", "touchstart"] as const;

/**
 * Mounted beside the router, outside it: a session that ends in use gets a sign-in dialog over the screen it was
 * on (the screen, and any draft in it, stays mounted), and a session near the server's idle cut-off gets a warning.
 */
export function IdleGuard() {
  const lost = useSyncExternalStore(session.subscribe, () => session.lost);
  return lost ? (
    <Suspense fallback={null}>
      <ReAuth />
    </Suspense>
  ) : (
    <IdleWarning />
  );
}

function IdleWarning() {
  // Tenant passkey sessions read the tenant's value; the vendor tier has no tenant settings to read.
  const tenant = useSyncExternalStore(session.subscribe, () => Boolean(session.token) && session.stage === "app" && !session.claims?.platform);
  // Read once per session: the full registry is large, and a change made in the settings screen refreshes it.
  const settings = useQuery({ ...get("/api/v1/settings"), enabled: tenant, staleTime: Infinity, refetchInterval: false, refetchOnWindowFocus: false });
  const minutes = settings.data?.items.find((e) => e.key === IDLE_KEY)?.value;
  const [now, setNow] = useState(Date.now);
  // When the server last held the session past this tab's own cut-off (another tab's input reached it, or a fault
  // left it unknown): the next check counts from then. Never input: it reports nothing to the server.
  const [confirmed, setConfirmed] = useState(0);
  // No value (not readable, not loaded): no warning, never a guessed timeout.
  const timeoutMs = tenant && typeof minutes === "number" ? minutes * 60_000 : null;
  const seen = lastActive();
  const last = seen === null ? null : Math.max(seen, confirmed);
  const at = idleCutoff(last, timeoutMs, now);
  // The press is itself input (auth/idle.ts recorded it first); the request carries it to the server at once. Nothing
  // else reports input now that nothing polls (decision #27), and the event stream never does (it is not activity).
  const shown = typeof at === "number";
  const ended = at === "ended";
  const stay = useCallback(() => {
    setNow(Date.now());
    void api.GET("/api/v1/users/me").catch(() => undefined);
  }, []);
  // Past the cut-off (a tab woken from sleep, a resumed or reloaded tab) no warning may name a time already gone: the
  // server decides. A refused refresh ends the session here (re-auth, "signed out for inactivity"); one it accepts
  // counts from now.
  useEffect(() => {
    if (!ended) return;
    let live = true;
    const later = () => void (live && setConfirmed(Date.now()));
    refresh().then(later, later);
    return () => void (live = false);
  }, [ended]);
  // No clock loop (decision #27): one timer at the moment the warning (or the cut-off) becomes due, re-armed on each
  // check. Before the first input, input checks again at once. While the warning shows, any real input means "stay
  // signed in", sent in the same event: re-rendering first would remove the button between its pointerdown and its
  // click, and the press would never reach the server. Input in another tab (storage) only checks again: that tab
  // reports its own.
  useEffect(() => {
    if (timeoutMs === null) return;
    const check = () => setNow(Date.now());
    // The warning's own timer is the cut-off itself: past it, the server is asked (above).
    const due = last === null || ended ? null : shown ? last + timeoutMs : last + timeoutMs - WARN_LEAD_MS;
    const timer = due === null ? undefined : setTimeout(check, Math.max(0, due - Date.now()) + 50);
    const listen = last === null || shown;
    const onInput = (e: Event) => {
      if (!shown) check();
      else if (e.isTrusted) stay();
    };
    // A tab shown again (after sleep, or from the background) checks at once: timers there run late or not at all.
    document.addEventListener("visibilitychange", check);
    if (listen) {
      for (const type of INPUT) document.addEventListener(type, onInput, { capture: true, passive: true });
      window.addEventListener("storage", check);
    }
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      if (!listen) return;
      for (const type of INPUT) document.removeEventListener(type, onInput, { capture: true });
      window.removeEventListener("storage", check);
    };
  }, [timeoutMs, last, shown, ended, stay]);
  if (!shown) return null;
  return (
    <div className={s.warning}>
      <Banner tone="warn" live="assertive" actions={<Button onClick={stay}>{t("idle.warn.stay")}</Button>}>
        {t("idle.warn.body", { time: fmtDateTime(new Date(at).toISOString()) })}
      </Banner>
    </div>
  );
}

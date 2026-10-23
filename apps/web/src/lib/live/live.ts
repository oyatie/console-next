// The shell's one event stream (decision #27, spec §5.2): opened when a principal signs in, before any screen's
// loader, and closed when the principal changes. Frames only invalidate reads (topics.ts); nothing here writes the
// cache, and nothing here re-reads on a timer.
import type { QueryClient } from "@tanstack/react-query";
import { refresh, session } from "@console/api";
import { openEventStream, type EventStream, type StreamFrame, type StreamOptions, type StreamSnapshot } from "@console/api/events";
import { invalidateWhere, shownWhere } from "../query";
import { INVALIDATE_DEBOUNCE_MS, OWN_ECHO_MS, REALTIME, RESET_JITTER_MAX_MS } from "../freshness";
import { ALL, matchChange, matchRecord, type Match } from "./topics";

/** A record on screen changed, and not by this tab's own write: `at` is the server's emit time (else arrival). */
export type RecordChange = { type: string; id: string; at: string };

const IDLE: StreamSnapshot = { state: "offline", since: 0, partial: [] };
let stream: EventStream | null = null;
let stop: (() => void) | null = null;
const statusListeners = new Set<() => void>();
const changeListeners = new Set<(c: RecordChange) => void>();

/** The stream's state for the shell, as a `useSyncExternalStore` source. */
export const liveStatus = {
  get: (): StreamSnapshot => stream?.get() ?? IDLE,
  subscribe(l: () => void) {
    statusListeners.add(l);
    return () => void statusListeners.delete(l);
  },
};

/** Calls `l` for every change to a record a screen is showing (ui/live ChangeNotice). */
export function onRecordChange(l: (c: RecordChange) => void) {
  changeListeners.add(l);
  return () => void changeListeners.delete(l);
}

/**
 * Holds (decision #27 amendment): a change from elsewhere never moves a screen nobody touched. While a sheet or dialog
 * is open, or a dashboard (Home) is mounted, the reads a frame names are only marked stale; a sheet applies them when
 * the last one closes, a dashboard when its user presses the held notice (`live.list.new_rows`).
 */
let holds = 0;
let noticeHolds = 0;
let held = 0;
let applyHeld: (() => void) | null = null;
const heldListeners = new Set<() => void>();
const emitHeld = () => heldListeners.forEach((l) => l());

/** How many changes a dashboard holds back (0 when nothing is held or no dashboard is mounted), for the notice. */
export const liveHeld = {
  get: () => (noticeHolds ? held : 0),
  subscribe(l: () => void) {
    heldListeners.add(l);
    return () => void heldListeners.delete(l);
  },
};

/** Re-reads every shown read a held change named (the notice's press, or the last sheet closing). */
export function showHeld() {
  held = 0;
  emitHeld();
  applyHeld?.();
}

/** Holds live re-reads until the returned release runs; `notice` (a dashboard) applies only on the notice's press. */
export function holdLive(notice = false) {
  holds++;
  if (notice) noticeHolds++;
  emitHeld();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds--;
    if (notice) noticeHolds--;
    if (!holds && held) showHeld();
    else emitHeld();
  };
}

const NETWORK = ["offline", "online"] as const;
const jitter = (max: number) => Math.random() * max;
const str = (v: unknown) => (typeof v === "string" ? v : null);

/** This tab wrote within the echo window (or is writing): its own change frames are not "someone else". */
const ownWrite = (qc: QueryClient) =>
  qc.getMutationCache().getAll().some((m) => m.state.status === "pending" || Date.now() - m.state.submittedAt < OWN_ECHO_MS);

/**
 * The transport behind the shell's stream: anything that turns `StreamOptions` into an `EventStream`. Today that is
 * SSE (`GET /api/v1/events`), the one-way channel decision #27 assigns to invalidations. A WebSocket source over the
 * same hub (`/api/v1/ws`: React Native fallback, or a two-way feature that also wants these frames) plugs in here.
 */
export type LiveSource = (o: StreamOptions) => EventStream;

/** Opens the stream for the signed-in principal (closing any previous one). */
export function openLive(qc: QueryClient, url = `${location.origin}/api/v1/events`, source: LiveSource = openEventStream) {
  closeLive();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (f: () => void, ms: number) => {
    const t = setTimeout(() => (timers.delete(t), f()), ms);
    timers.add(t);
  };
  // Invalidations collect for the debounce window and land as one; under a hold they only mark reads stale.
  let pending: Match[] = [];
  const queue = (m: Match) => {
    if (!pending.length) later(() => {
      const ms = pending;
      pending = [];
      if (holds) {
        held += ms.length;
        emitHeld();
      }
      void invalidateWhere(qc, (path, params) => ms.some((x) => x(path, params)), !holds);
    }, INVALIDATE_DEBOUNCE_MS);
    pending.push(m);
  };
  applyHeld = () => void qc.refetchQueries({ type: "active", predicate: (q) => q.state.isInvalidated });

  const onFrame = ({ event, data }: StreamFrame) => {
    const d = (data ?? {}) as { type?: unknown; id?: unknown; at?: unknown; wide?: unknown };
    if (event === "reset") return later(() => queue(ALL), jitter(RESET_JITTER_MAX_MS));
    if (event !== "change" || typeof d.type !== "string") return;
    if (d.type === "support_session") {
      void invalidateWhere(qc, matchChange(d.type, str(d.id)), true);
      return;
    }
    // Imports keep running and recovery has other actors: a recent write cannot suppress their next step.
    if (d.type !== "import_run" && d.type !== "ops_recovery" && ownWrite(qc)) return;
    const id = str(d.id);
    const record = matchRecord(d.type, id);
    if (record && id && shownWhere(qc, record)) {
      const c = { type: d.type, id, at: str(d.at) ?? new Date().toISOString() };
      changeListeners.forEach((l) => l(c));
    }
    const m = matchChange(d.type, id);
    if (d.wide === true) later(() => queue(m), jitter(RESET_JITTER_MAX_MS));
    else queue(m);
  };

  const s = source({ url, token: () => session.token, refresh, onFrame, tune: REALTIME });
  // A reconnect that could not resume (no cursor to send) may have missed changes: everything shown re-reads
  // once. A reconnect that sends `Last-Event-ID` is caught up by the server's replay, or told `reset`.
  // the first connection does not re-read reads that landed before it registered (a change in that
  // gap of milliseconds shows on the next change); add the spec F8.2 `hello` check if the gap is ever seen.
  let prev = s.get().state;
  let wasLive = false;
  let cursor = "";
  const unsubscribe = s.subscribe(() => {
    const { state } = s.get();
    if (state !== prev) {
      if (state === "connecting") cursor = s.lastEventId;
      if (state === "live" && wasLive && !cursor) queue(ALL);
      if (state === "live") wasLive = true;
      prev = state;
    }
    statusListeners.forEach((l) => l());
  });
  // The browser knows the network went away before a silent stream's heartbeat check does (2 x 25 s), and knows when
  // it is back before the backoff ends: either way, reconnect now, so the outage shows and ends when it happens.
  const kick = () => s.reconnect();
  for (const type of NETWORK) globalThis.addEventListener?.(type, kick);
  // A renewed access token (packages/api session.ts renews it before expiry) reopens the stream at once, before the
  // server closes the old one at its expiry: the reconnect never presents an expired token (no 401).
  let opened = session.token;
  const offSession = session.subscribe(() => {
    if (!session.token || session.token === opened) return;
    opened = session.token;
    s.reconnect();
  });
  stream = s;
  stop = () => {
    applyHeld = null;
    held = 0;
    emitHeld();
    for (const type of NETWORK) globalThis.removeEventListener?.(type, kick);
    offSession();
    unsubscribe();
    timers.forEach(clearTimeout);
    s.close();
  };
  statusListeners.forEach((l) => l());
}

/** Closes the stream (sign-out, or before another principal's stream opens). */
export function closeLive() {
  stop?.();
  stop = null;
  stream = null;
  statusListeners.forEach((l) => l());
}

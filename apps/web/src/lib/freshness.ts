// How server data stays current (decision #27): never by polling. A shown read is re-read only when the shell's one
// event stream (lib/live) says something it reads changed, or once after the stream lost its place. A write that lost
// a race still meets the server's 409 (field_conflict / stale_facts), never a silent overwrite. Values are named by
// their settings-registry keys (data-display-and-realtime.md §9).
// constants until the settings client (FE-SET) serves resolved values; read them there then.
import type { RealtimeTunables } from "@console/api/events";

/** `query.stale_time`: a read younger than this is not re-read when a screen mounts it again. */
export const STALE_TIME_MS = 30_000;

/** `display.search_debounce`: wait for a pause in typing before a server search. */
export const SEARCH_DEBOUNCE_MS = 100;

/** `realtime.*` stream tunables (spec §5.1). */
export const REALTIME: RealtimeTunables = {
  retryHint: 3_000,
  reconnectBackoffMax: 30_000,
  backoffResetAfter: 30_000,
  heartbeatInterval: 25_000,
  deadAfterHeartbeats: 2,
};
/** `realtime.invalidate_debounce`: a burst of change frames is applied as one invalidation. */
export const INVALIDATE_DEBOUNCE_MS = 250;
/** `realtime.reset_jitter_max`: a `reset` or a `wide` frame spreads its re-reads over this window. */
export const RESET_JITTER_MAX_MS = 10_000;
/** `display.reconnecting_after`: the shell says the stream is down only after it has been down this long. */
export const RECONNECTING_AFTER_MS = 3_000;
/** How long after this tab's own write a change frame is taken as its echo, not someone else's change. */
export const OWN_ECHO_MS = 5_000;

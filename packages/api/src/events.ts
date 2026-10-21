/**
 * Reader for the realtime SSE stream (`GET /api/v1/events`, spec §5.1). Platform-neutral: no React,
 * no DOM, no import of the session/platform modules, so it runs unchanged on web and on React Native
 * (`expo/fetch` streams `body.getReader()`). The caller injects auth and the settings values.
 */

// The WHATWG globals this module uses, typed here so it compiles under `lib: ["ES2023"]` with no
// DOM or node types (the pure gate). Browsers, Node and Expo provide them. Hermes `TextDecoder`
// is not verified: if it is missing, the native adapter must install a polyfill.
type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }> };
type Res = { status: number; headers: { get(name: string): string | null }; body: { getReader(): Reader } | null };
type Signal = object;
/** The subset of WHATWG `fetch` the reader needs. */
export type Fetch = (url: string, init: { headers: Record<string, string>; signal: Signal }) => Promise<Res>;
declare const fetch: Fetch;
declare const AbortController: new () => { signal: Signal; abort(): void };
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };
declare const setTimeout: (f: () => void, ms: number) => unknown;
declare const clearTimeout: (handle: unknown) => void;

/** One dispatched frame, data still as text. */
export type RawFrame = { event: string; data: string };
/** Fields that outlive a frame and a connection (WHATWG: the last-event-ID buffer and the reconnection time). */
export type Cursor = { lastEventId: string; retry?: number };

const LF = 10;

/**
 * Bytes to frames. A frame is decoded only once its `\n\n` has arrived, so a multi-byte character
 * or the separator split across chunks cannot corrupt it (F14). One parser per connection: a partial
 * frame from a dropped connection is discarded with it.
 * `\n` line endings only (axum's); add CR/CRLF if a server or proxy ever rewrites them.
 */
export function createParser(cursor: Cursor, onFrame: (f: RawFrame) => void) {
  const decoder = new TextDecoder();
  let buf = new Uint8Array(0);
  const block = (text: string) => {
    let event = "";
    const data: string[] = [];
    for (const line of text.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const raw = colon < 0 ? "" : line.slice(colon + 1);
      const value = raw.startsWith(" ") ? raw.slice(1) : raw;
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id" && !value.includes("\0")) cursor.lastEventId = value;
      else if (field === "retry" && /^\d+$/.test(value)) cursor.retry = Number(value);
    }
    if (data.length) onFrame({ event: event || "message", data: data.join("\n") });
  };
  return (chunk: Uint8Array) => {
    const scanFrom = Math.max(0, buf.length - 1);
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf);
    next.set(chunk, buf.length);
    buf = next;
    let start = 0;
    for (let i = scanFrom; i + 1 < buf.length; i++) {
      if (buf[i] !== LF || buf[i + 1] !== LF) continue;
      block(decoder.decode(buf.subarray(start, i)));
      start = i + 2;
      i++;
    }
    if (start > 0) buf = buf.slice(start);
  };
}

/** Settings values (spec §9), in milliseconds unless noted. Resolved by the caller; no defaults here. */
export type RealtimeTunables = {
  /** `realtime.retry_hint`: backoff base until the server sends `retry:` or `hello.retry_ms`. */
  retryHint: number;
  /** `realtime.reconnect_backoff_max` */
  reconnectBackoffMax: number;
  /** `realtime.backoff_reset_after`: uptime after which the backoff exponent resets. */
  backoffResetAfter: number;
  /** `realtime.heartbeat_interval` */
  heartbeatInterval: number;
  /** `realtime.dead_after_heartbeats` (a count): silence for this many intervals aborts the connection. */
  deadAfterHeartbeats: number;
};

/**
 * `connecting`: a connection attempt, a refresh or a backoff wait is in progress (retrying covers
 * network errors, 5xx and 429). `live`: a 200 `text/event-stream` response is open.
 * `offline`: not retrying, because the session is gone (refresh failed) or `close()` was called.
 */
export type StreamState = "live" | "connecting" | "offline";
export type StreamSnapshot = { state: StreamState; since: number; partial: readonly string[] };
export type StreamFrame = { event: string; data: unknown };

export type StreamOptions = {
  url: string;
  /** Current access token, or null to send none (cookie session). */
  token: () => string | null;
  /** Rotates the access token; resolves false when the session is gone. */
  refresh: () => Promise<boolean>;
  onFrame: (frame: StreamFrame) => void;
  /** Defaults to the global. Expo must pass `fetch` from `expo/fetch`: the RN global does not stream bodies. */
  fetch?: Fetch;
  /** Resume cursor, e.g. from a stream closed while the tab was hidden. */
  lastEventId?: string;
  tune: RealtimeTunables;
};

export type EventStream = {
  /** Stable until the next change, so it suits `useSyncExternalStore`. */
  get(): StreamSnapshot;
  subscribe(listener: () => void): () => void;
  /** The cursor to pass to the next `openEventStream` after `close()`. */
  readonly lastEventId: string;
  /**
   * Drops the open connection, or ends a backoff wait, and connects again now: the platform says the network went
   * away (a stream on a dead link can stay silent until the heartbeat check) or came back (no need to wait).
   */
  reconnect(): void;
  close(): void;
};

/** Opens the stream and keeps it open: full-jitter backoff, dead-connection abort, resume by `Last-Event-ID`. */
export function openEventStream(o: StreamOptions): EventStream {
  const cursor: Cursor = { lastEventId: o.lastEventId ?? "" };
  let snap: StreamSnapshot = { state: "connecting", since: Date.now(), partial: [] };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<StreamSnapshot>) => {
    if (patch.state === snap.state) delete patch.state;
    if (!Object.keys(patch).length) return;
    snap = { ...snap, ...patch, since: patch.state ? Date.now() : snap.since };
    listeners.forEach((l) => l());
  };

  let closed = false;
  let attempt = 0;
  let abort: (() => void) | null = null;
  let wait: unknown;
  let skipWait: (() => void) | null = null;

  const dispatch = (f: RawFrame) => {
    let data: unknown;
    try {
      data = JSON.parse(f.data);
    } catch {
      return; // JSON is the wire format; anything else is not a frame of ours.
    }
    if (f.event === "hello" && data && typeof data === "object") {
      const h = data as { retry_ms?: unknown; partial?: unknown };
      if (typeof h.retry_ms === "number" && h.retry_ms >= 0) cursor.retry = h.retry_ms;
      const partial = Array.isArray(h.partial) ? h.partial.filter((t): t is string => typeof t === "string") : [];
      if (partial.join() !== snap.partial.join()) set({ partial });
    }
    try {
      o.onFrame({ event: f.event, data });
    } catch (e) {
      void Promise.reject(e); // Report it, but a consumer bug is not a connection failure.
    }
  };

  /** One connection. Resolves when it ends; "stop" only when the session is gone. */
  async function connect(): Promise<"retry" | "stop"> {
    const ctrl = new AbortController();
    abort = () => ctrl.abort();
    let dead: unknown;
    // Any byte counts as a heartbeat: axum's KeepAlive sends `:` comment lines, which dispatch nothing.
    const arm = () => {
      clearTimeout(dead);
      dead = setTimeout(() => ctrl.abort(), o.tune.heartbeatInterval * o.tune.deadAfterHeartbeats);
    };
    let liveAt = 0;
    try {
      arm();
      const headers: Record<string, string> = { accept: "text/event-stream" };
      const token = o.token();
      if (token) headers.authorization = `Bearer ${token}`;
      if (cursor.lastEventId) headers["last-event-id"] = cursor.lastEventId;
      const res = await (o.fetch ?? fetch)(o.url, { headers, signal: ctrl.signal });
      // A refresh that succeeds still goes through backoff, so a 401 that persists cannot spin.
      if (res.status === 401) return (await o.refresh()) ? "retry" : "stop";
      if (res.status !== 200 || !res.body || !res.headers.get("content-type")?.startsWith("text/event-stream")) return "retry";
      if (closed) return "retry";
      liveAt = Date.now();
      set({ state: "live" });
      const push = createParser(cursor, dispatch);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        if (value) push(value);
      }
    } catch {
      // Network error, abort (dead or closed), or a refresh that threw: all retry.
    } finally {
      clearTimeout(dead);
      ctrl.abort(); // Releases a body we did not read.
      if (liveAt && Date.now() - liveAt >= o.tune.backoffResetAfter) attempt = 0;
    }
    return "retry";
  }

  async function run() {
    for (;;) {
      const outcome = await connect();
      if (closed) return;
      if (outcome === "stop") return set({ state: "offline" });
      set({ state: "connecting" });
      const base = cursor.retry ?? o.tune.retryHint;
      const ms = Math.random() * Math.min(o.tune.reconnectBackoffMax, base * 2 ** attempt++);
      await new Promise<void>((resolve) => {
        skipWait = resolve;
        wait = setTimeout(resolve, ms);
      });
      skipWait = null;
      if (closed) return;
    }
  }
  void run();

  return {
    get: () => snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    get lastEventId() {
      return cursor.lastEventId;
    },
    reconnect() {
      if (closed) return;
      if (!skipWait) return abort?.();
      clearTimeout(wait);
      skipWait();
    },
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(wait);
      abort?.();
      set({ state: "offline" });
    },
  };
}

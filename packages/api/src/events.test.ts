import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createParser, openEventStream, type Cursor, type RawFrame, type RealtimeTunables, type StreamOptions } from "./events";

const enc = new TextEncoder();
const tune: RealtimeTunables = { retryHint: 3_000, reconnectBackoffMax: 30_000, backoffResetAfter: 30_000, heartbeatInterval: 25_000, deadAfterHeartbeats: 2 };

function parse(chunks: Uint8Array[], cursor: Cursor = { lastEventId: "" }) {
  const frames: RawFrame[] = [];
  const push = createParser(cursor, (f) => frames.push(f));
  chunks.forEach(push);
  return { frames, cursor };
}

test("a 3-byte character and the separator split at every byte boundary still yield exactly one frame", () => {
  const bytes = enc.encode('event: change\ndata: {"name":"한글"}\n\n');
  for (let a = 1; a < bytes.length; a++)
    for (let b = a; b < bytes.length; b++) {
      const { frames } = parse([bytes.slice(0, a), bytes.slice(a, b), bytes.slice(b)]);
      expect(frames, `split at ${a},${b}`).toEqual([{ event: "change", data: '{"name":"한글"}' }]);
    }
});

test("comments are skipped, data lines join, the event defaults to message, and an empty frame dispatches nothing", () => {
  const { frames } = parse([enc.encode(":\n\n: keep-alive\ndata: a\ndata:b\n\nevent: x\n\ndata\n\n")]);
  expect(frames).toEqual([
    { event: "message", data: "a\nb" },
    { event: "message", data: "" },
  ]);
});

test("id: persists across frames without one; retry: takes digits only; an id with NUL is ignored", () => {
  const { frames, cursor } = parse([enc.encode("id: 7\nretry: 5000\ndata: 1\n\nevent: job\ndata: 2\n\nretry: 1s\nid: a\0b\ndata: 3\n\n")]);
  expect(frames.map((f) => f.data)).toEqual(["1", "2", "3"]);
  expect(cursor).toEqual({ lastEventId: "7", retry: 5000 });
});

// ---- the connection loop ----------------------------------------------------------------------

type Conn = { url: string; headers: Record<string, string>; send(s: string): void; end(): void };
let conns: Conn[];
let replies: (() => Response | Promise<Response>)[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1); // full jitter at its ceiling: the delay is the cap itself
  conns = [];
  replies = [];
  vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
    const reply = replies.shift();
    if (reply) return reply();
    // Otherwise a streaming 200 whose controller the test drives; aborting the request errors the body.
    let c!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (x) => void (c = x) });
    init.signal.addEventListener("abort", () => c.error(new Error("aborted")));
    conns.push({ url, headers: init.headers, send: (s) => c.enqueue(enc.encode(s)), end: () => c.close() });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function open(extra: Partial<StreamOptions> = {}) {
  const frames: { event: string; data: unknown }[] = [];
  const states: string[] = [];
  const s = openEventStream({ url: "/api/v1/events", token: () => "tok", refresh: async () => true, onFrame: (f) => frames.push(f), tune, ...extra });
  s.subscribe(() => states.push(s.get().state));
  return { s, frames, states };
}
const tick = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

test("goes live, parses JSON frames, takes partial and retry_ms from hello, and skips non-JSON data", async () => {
  const { s, frames, states } = open();
  await tick();
  expect(conns[0]!.headers).toEqual({ accept: "text/event-stream", authorization: "Bearer tok" });
  expect(s.get().state).toBe("live");
  conns[0]!.send('id: 10\nevent: hello\ndata: {"retry_ms":1000,"partial":["employee"]}\n\ndata: not json\n\nevent: change\ndata: {"type":"employee","id":"e1"}\n\n');
  await tick();
  expect(frames).toEqual([
    { event: "hello", data: { retry_ms: 1000, partial: ["employee"] } },
    { event: "change", data: { type: "employee", id: "e1" } },
  ]);
  expect(s.get().partial).toEqual(["employee"]);
  expect(s.lastEventId).toBe("10");

  conns[0]!.end();
  await tick();
  expect(states).toEqual(["live", "live", "connecting"]); // the second notice is the `partial` change
  await tick(999);
  expect(conns).toHaveLength(1); // backoff base is hello's retry_ms: 1000 × 2^0
  await tick(1);
  expect(conns[1]!.headers["last-event-id"]).toBe("10");
  conns[1]!.send('event: hello\ndata: {"retry_ms":1000,"partial":["employee"]}\n\n');
  await tick();
  expect(states).toEqual(["live", "live", "connecting", "live"]); // an unchanged `partial` notifies nobody
  s.close();
});

test("a frame without id: keeps the cursor; the backoff doubles up to the cap and resets after enough uptime", async () => {
  const { s } = open({ lastEventId: "4" });
  await tick();
  expect(conns[0]!.headers["last-event-id"]).toBe("4");
  conns[0]!.send('event: job\ndata: {"job_id":"j","done":1,"total":2}\n\n');
  conns[0]!.end();
  // Short-lived connections: delays 3 s, 6 s, 12 s, 24 s, then capped at 30 s.
  for (const delay of [3_000, 6_000, 12_000, 24_000, 30_000]) {
    const before = conns.length;
    await tick(delay - 1);
    expect(conns).toHaveLength(before);
    await tick(1);
    expect(conns).toHaveLength(before + 1);
    expect(conns.at(-1)!.headers["last-event-id"]).toBe("4");
    conns.at(-1)!.end();
  }
  // One long-lived connection resets the exponent.
  await tick(30_000);
  await tick(tune.backoffResetAfter);
  conns.at(-1)!.send(":\n\n"); // keep the dead timer quiet past 50 s
  conns.at(-1)!.end();
  const before = conns.length;
  await tick(3_000);
  expect(conns).toHaveLength(before + 1);
  s.close();
});

test("comment heartbeats keep a quiet stream alive; silence for two intervals aborts and reconnects", async () => {
  const { s, states } = open();
  await tick();
  for (let i = 0; i < 4; i++) {
    await tick(24_000);
    conns[0]!.send(":\n\n");
  }
  expect(conns).toHaveLength(1);
  expect(s.get().state).toBe("live");
  await tick(50_000);
  expect(states).toEqual(["live", "connecting"]);
  await tick(3_000);
  expect(conns).toHaveLength(2);
  expect(s.get().state).toBe("live");
  s.close();
});

test("a 401 refreshes, then reconnects with the new token after the backoff", async () => {
  let token = "old";
  const refresh = vi.fn(async () => ((token = "new"), true));
  replies.push(() => new Response(null, { status: 401 }));
  const { s, states } = open({ token: () => token, refresh });
  await tick();
  expect(refresh).toHaveBeenCalledOnce();
  expect(states).toEqual([]); // stays connecting through the refresh: no state flap
  await tick(3_000);
  expect(conns[0]!.headers.authorization).toBe("Bearer new");
  expect(s.get().state).toBe("live");
  s.close();
});

test("a 401 whose refresh fails goes offline and stops retrying", async () => {
  const fetchSpy = vi.fn(async () => new Response(null, { status: 401 }));
  vi.stubGlobal("fetch", fetchSpy);
  const { s } = open({ refresh: async () => false });
  await tick(60_000);
  expect(s.get().state).toBe("offline");
  expect(fetchSpy).toHaveBeenCalledOnce();
});

test("a 429, a 5xx or a non-SSE 200 retries; close() aborts the stream and goes offline once", async () => {
  replies.push(
    () => new Response(null, { status: 429 }),
    () => new Response(null, { status: 503 }),
    () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
  );
  const { s, states } = open();
  await tick(3_000 + 6_000 + 12_000);
  expect(conns).toHaveLength(1);
  expect(s.get().state).toBe("live");
  s.close();
  s.close();
  await tick(60_000);
  expect(conns).toHaveLength(1);
  expect(states).toEqual(["live", "offline"]);
  expect(s.get().since).toBe(Date.now() - 60_000);
});

test("an injected fetch (expo/fetch on React Native) replaces the global", async () => {
  const global = vi.fn();
  vi.stubGlobal("fetch", global);
  const injected = vi.fn(async () => new Response(null, { status: 503 }));
  const { s } = open({ fetch: injected });
  await tick();
  expect(injected).toHaveBeenCalledOnce();
  expect(global).not.toHaveBeenCalled();
  s.close();
});

test("reconnect() drops a live connection at once and cuts a backoff wait short (the network went or came back)", async () => {
  const { s, states } = open();
  await tick();
  s.reconnect(); // offline: no waiting for two silent heartbeats
  await tick();
  expect(states).toEqual(["live", "connecting"]);
  s.reconnect(); // online: no waiting for the backoff
  await tick();
  expect(conns).toHaveLength(2);
  expect(s.get().state).toBe("live");
  s.close();
  s.reconnect(); // closed stays closed
  await tick(60_000);
  expect(conns).toHaveLength(2);
});

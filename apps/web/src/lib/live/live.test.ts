import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { interactionHeaders, lastTouch } from "@console/api";
import type { StreamOptions, StreamSnapshot, StreamState } from "@console/api/events";
import { get, isInvalidated } from "../query";
import { closeLive, holdLive, liveHeld, liveStatus, onRecordChange, openLive, showHeld } from "./live";

// A fake stream the test drives: frames, state flips and the cursor.
const fake = vi.hoisted(() => ({ opts: null as StreamOptions | null, snap: null as StreamSnapshot | null, lastEventId: "", listeners: new Set<() => void>(), closed: 0 }));
vi.mock("@console/api/events", () => ({
  openEventStream: (o: StreamOptions) => {
    fake.opts = o;
    fake.snap = { state: "connecting", since: Date.now(), partial: [] };
    fake.lastEventId = "";
    fake.listeners.clear();
    return {
      get: () => fake.snap,
      subscribe: (l: () => void) => (fake.listeners.add(l), () => void fake.listeners.delete(l)),
      get lastEventId() {
        return fake.lastEventId;
      },
      close: () => void fake.closed++,
    };
  },
}));
const to = (state: StreamState) => {
  fake.snap = { ...fake.snap!, state, since: Date.now() };
  fake.listeners.forEach((l) => l());
};
const frame = (event: string, data: unknown) => fake.opts!.onFrame({ event, data });

const E1 = get("/api/v1/employees/{id}", { params: { path: { id: "e1" } } });
const E2 = get("/api/v1/employees/{id}", { params: { path: { id: "e2" } } });
const LIST = get("/api/v1/employees", { params: { query: {} } });
const CHANGES = get("/api/v1/org-changes", { params: { query: {} } });
let qc: QueryClient;
const load = async (...qs: object[]) => {
  for (const q of qs) await qc.prefetchQuery({ ...(q as typeof E1), queryFn: async () => ({}) as never });
};
const stale = () => [E1, E2, LIST, CHANGES].map((q) => isInvalidated(qc, q));

beforeEach(async () => {
  vi.useFakeTimers();
  qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, gcTime: Infinity } } });
  await load(E1, E2, LIST, CHANGES);
  openLive(qc, "http://test/api/v1/events");
});
afterEach(() => {
  closeLive();
  vi.useRealTimers();
});

test("a change frame invalidates its record and lists after the debounce, nothing else", async () => {
  frame("change", { type: "employee", id: "e1", at: "2026-10-06T09:00:00Z" });
  expect(stale()).toEqual([false, false, false, false]);
  await vi.advanceTimersByTimeAsync(250);
  expect(stale()).toEqual([true, false, true, false]);
});

test("a burst of frames lands as one invalidation", async () => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  frame("change", { type: "employee", id: "e1" });
  frame("change", { type: "employee", id: "e2" });
  frame("change", { type: "org_change", id: "c1" });
  await vi.advanceTimersByTimeAsync(250);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(stale()).toEqual([true, true, true, true]);
});

test("a reconnect that lost its cursor re-reads everything exactly once; a resumed one, partial updates and blips do not", async () => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  to("live"); // first connection: nothing to catch up on
  to("connecting");
  to("live"); // no cursor was sent: lost
  fake.snap = { ...fake.snap!, partial: ["employee"] };
  fake.listeners.forEach((l) => l()); // a hello's partial list, still live
  await vi.advanceTimersByTimeAsync(250);
  expect(spy).toHaveBeenCalledTimes(1);
  expect(stale()).toEqual([true, true, true, true]);
  fake.lastEventId = "42";
  to("connecting");
  to("live"); // resumed with Last-Event-ID: the server replays
  await vi.advanceTimersByTimeAsync(10_000);
  expect(spy).toHaveBeenCalledTimes(1);
});

test("nothing re-reads on a timer: an hour of a live, quiet stream invalidates nothing", async () => {
  const spy = vi.spyOn(qc, "invalidateQueries");
  to("live");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(spy).not.toHaveBeenCalled();
});

test("reset re-reads everything once, within the jitter window", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  frame("reset", { reason: "pruned" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(stale()).toEqual([false, false, false, false]);
  await vi.advanceTimersByTimeAsync(250);
  expect(stale()).toEqual([true, true, true, true]);
});

test("a record on screen changed elsewhere is announced; an unshown one, or this tab's own write, is not", async () => {
  const seen: string[] = [];
  const off = onRecordChange((c) => seen.push(c.id));
  const shown = new QueryObserver(qc, E1).subscribe(() => undefined);
  frame("change", { type: "employee", id: "e2" });
  frame("change", { type: "employee", id: "e1", at: "2026-10-06T09:00:00Z" });
  expect(seen).toEqual(["e1"]);
  await qc.getMutationCache().build(qc, { mutationFn: async () => 1 }).execute(undefined);
  frame("change", { type: "employee", id: "e1" });
  expect(seen).toEqual(["e1"]);
  shown();
  off();
});

test("an import job's completion is read during this tab's own-write window", async () => {
  const query = get("/api/v1/employees/import/{run_id}/apply", { params: { path: { run_id: "r1" } } });
  let state = "applying";
  const observer = new QueryObserver(qc, { ...query, queryFn: async () => ({ state }) as never });
  const off = observer.subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(observer.getCurrentResult().data).toEqual({ state: "applying" });
  await qc.getMutationCache().build(qc, { mutationFn: async () => 1 }).execute(undefined);
  state = "done";
  frame("change", { type: "import_run", id: "r1" });
  await vi.advanceTimersByTimeAsync(250);
  expect(observer.getCurrentResult().data).toEqual({ state: "done" });
  off();
});

test("this tab's own write's echo re-reads and marks nothing (the sheet's reads stay as opened); another's change re-reads", async () => {
  const read = vi.fn(async () => ({}) as never);
  const off = new QueryObserver(qc, { ...E1, queryFn: read }).subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  read.mockClear();
  await qc.getMutationCache().build(qc, { mutationFn: async () => 1 }).execute(undefined);
  frame("change", { type: "employee", id: "e1" });
  await vi.advanceTimersByTimeAsync(250);
  expect(read).not.toHaveBeenCalled();
  expect(stale()).toEqual([false, false, false, false]);
  await vi.advanceTimersByTimeAsync(5_000); // past the echo window: someone else's change
  frame("change", { type: "employee", id: "e1" });
  await vi.advanceTimersByTimeAsync(250);
  expect(read).toHaveBeenCalledTimes(1);
  off();
});

test("while a sheet is open a change from elsewhere waits: marked stale, re-read when the last sheet closes", async () => {
  const read = vi.fn(async () => ({}) as never);
  const off = new QueryObserver(qc, { ...E1, queryFn: read }).subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  read.mockClear();
  const [a, b] = [holdLive(), holdLive()];
  frame("change", { type: "employee", id: "e1" });
  await vi.advanceTimersByTimeAsync(250);
  expect(read).not.toHaveBeenCalled();
  expect(isInvalidated(qc, E1)).toBe(true);
  expect(liveHeld.get()).toBe(0); // a sheet shows no held notice
  a();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).not.toHaveBeenCalled(); // one sheet still open
  b();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  off();
});

test("a dashboard holds changes from elsewhere behind its notice until pressed; nothing moves meanwhile", async () => {
  const read = vi.fn(async () => ({}) as never);
  const off = new QueryObserver(qc, { ...E1, queryFn: read }).subscribe(() => undefined);
  await vi.advanceTimersByTimeAsync(0);
  read.mockClear();
  const release = holdLive(true);
  const sheet = holdLive();
  frame("change", { type: "employee", id: "e1" });
  await vi.advanceTimersByTimeAsync(250);
  frame("change", { type: "org_change", id: "c1" });
  await vi.advanceTimersByTimeAsync(250);
  expect(liveHeld.get()).toBe(2);
  sheet(); // a sheet closing on a dashboard applies nothing
  await vi.advanceTimersByTimeAsync(0);
  expect(read).not.toHaveBeenCalled();
  showHeld();
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  expect(liveHeld.get()).toBe(0);
  release();
  off();
});

test("the stream is never user activity: frames, re-reads and reconnects record no input (BW-24 / INF-03)", async () => {
  to("live");
  frame("change", { type: "employee", id: "e1", ver: null, at: "2026-10-08T00:00:00Z" });
  frame("reset", { reason: "gap" });
  to("connecting");
  to("live");
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(lastTouch()).toBeNull();
  expect(interactionHeaders()).toEqual({});
});

test("the shell sees the stream state, and closing leaves it offline", () => {
  to("live");
  expect(liveStatus.get().state).toBe("live");
  closeLive();
  expect(liveStatus.get().state).toBe("offline");
  expect(fake.closed).toBeGreaterThan(0);
});

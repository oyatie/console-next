import { afterEach, expect, test, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { ApiError } from "@console/api";
import { get } from "../query";
import { MAX_RETRY_AFTER_MS, queryDefaults } from "./query-defaults";

afterEach(() => vi.restoreAllMocks());

const reads = (status: number) => {
  const client = new QueryClient({ defaultOptions: { queries: { ...queryDefaults, retryDelay: 0 } } });
  let calls = 0;
  const options = {
    ...get("/api/v1/period-locks"),
    queryFn: async () => {
      calls += 1;
      throw new ApiError(status, status === 403 ? "forbidden" : "internal", "refused");
    },
  };
  const mount = async () => {
    const o = new QueryObserver(client, options);
    const off = o.subscribe(() => {});
    await vi.waitFor(() => expect(o.getCurrentResult().isError).toBe(true));
    return off;
  };
  return { mount, calls: () => calls };
};

// regression (governance-21, people-self-04): a 403 page that mounted a part reading the same query re-asked on
// every mount, ~316 GET /period-locks in 3 minutes.
test("a refused read is asked once: no retry, and a second view mounting on it does not ask again", async () => {
  const r = reads(403);
  (await r.mount())();
  (await r.mount())();
  (await r.mount())();
  expect(r.calls()).toBe(1);
});

test.each([500, 503, 0])("an exhausted fault (%s) survives 50 remounts without a new retry budget", async (status) => {
  const r = reads(status);
  for (let i = 0; i < 50; i++) (await r.mount())();
  expect(r.calls()).toBe(3);
});

test("a pending shell gate and its child share one failed read, even when the child opts out of retries", async () => {
  const client = new QueryClient({ defaultOptions: { queries: queryDefaults } });
  let calls = 0;
  const options = { ...get("/api/v1/onboarding/checklist"), retry: false as const, queryFn: async () => {
    calls++;
    throw new ApiError(503, "service_unavailable", "busy");
  } };
  const gate = new QueryObserver(client, options);
  let child: (() => void) | undefined;
  const stop = gate.subscribe((q) => {
    if (q.isPending) { child?.(); child = undefined; }
    else if (!child && calls < 50) child = new QueryObserver(client, { ...options, refetchOnMount: "always" }).subscribe(() => {});
  });
  await vi.waitFor(() => expect(gate.getCurrentResult().isError).toBe(true));
  expect(calls).toBe(1);
  child?.();
  stop();
  client.clear();
});

test("several readers share the retry budget; a person's retry can recover after it is spent", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { ...queryDefaults, retryDelay: 0 } } });
  const queryFn = vi.fn().mockRejectedValue(new ApiError(503, "service_unavailable", "busy"));
  const options = { ...get("/api/v1/org-units"), queryFn };
  const views = Array.from({ length: 5 }, () => new QueryObserver(client, options));
  const stops = views.map((view) => view.subscribe(() => {}));
  await vi.waitFor(() => expect(views.every((v) => v.getCurrentResult().isError)).toBe(true));
  expect(queryFn).toHaveBeenCalledTimes(3);
  queryFn.mockResolvedValue({ items: [] });
  await views[0]!.refetch();
  expect(queryFn).toHaveBeenCalledTimes(4);
  expect(views.every((v) => v.getCurrentResult().isSuccess)).toBe(true);
  stops.forEach((stop) => stop());
  client.clear();
});

test("a fault waits the server's Retry-After; nothing re-reads on focus or reconnect (decision #27)", () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  const shed = new ApiError(503, "service_unavailable", "busy", [], undefined, true, [], { retryAfterMs: 15_000 });
  expect(queryDefaults.retryDelay(0, shed)).toBe(15_000);
  expect(queryDefaults.retryDelay(1, new ApiError(500, "internal", "x"))).toBe(3000);
  expect(queryDefaults).toMatchObject({ refetchOnWindowFocus: false, refetchOnReconnect: false });
  expect(Object.keys(queryDefaults).filter((k) => k.startsWith("refetch"))).toHaveLength(2); // the two above, no interval
});

test("backoff is exponential with bounded jitter; a zero Retry-After cannot produce immediate retries", () => {
  const random = vi.spyOn(Math, "random");
  const error = new ApiError(503, "busy", "busy", [], undefined, true, [], { retryAfterMs: 0 });
  random.mockReturnValue(0);
  expect(queryDefaults.retryDelay(0, error)).toBe(1000);
  expect(queryDefaults.retryDelay(1, error)).toBe(2000);
  random.mockReturnValue(0.75);
  expect(queryDefaults.retryDelay(0, error)).toBe(1750);
  expect(queryDefaults.retryDelay(1, error)).toBe(3500);
  expect(queryDefaults.retryDelay(10, error)).toBe(MAX_RETRY_AFTER_MS);
});

// TS-28: a 429 that says when to come back was an "answer" (no retry); a Retry-After of an hour was waited out silently.
test("a 429 or 503 with Retry-After is retried after that wait; a wait past 30 s is not waited out; a bare 429 is an answer", () => {
  const busy = (status: number, retryAfterMs?: number) => new ApiError(status, "busy", "busy", [], undefined, true, [], { retryAfterMs });
  expect(queryDefaults.retry(0, busy(429, 2000))).toBe(true);
  expect(queryDefaults.retryDelay(0, busy(429, 2000))).toBe(2000);
  expect(queryDefaults.retry(1, busy(429, 2000))).toBe(true);
  expect(queryDefaults.retry(2, busy(429, 2000))).toBe(false); // bounded: twice at most
  expect(queryDefaults.retry(0, busy(429, MAX_RETRY_AFTER_MS))).toBe(true);
  expect(queryDefaults.retry(0, busy(429, MAX_RETRY_AFTER_MS + 1))).toBe(false);
  expect(queryDefaults.retry(0, busy(503, 3_600_000))).toBe(false);
  expect(queryDefaults.retry(0, busy(429))).toBe(false);
  expect(queryDefaults.retry(0, busy(503))).toBe(true); // a fault without a hint keeps the backoff
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, vi } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { BACKGROUND_SETTLE_MS, get, invalidatePaths, invalidateWhere } from "./query";

test("a background read is re-read once after invalidations go quiet, never ahead of the page's own reads", async () => {
  vi.useFakeTimers();
  try {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const calls = { page: 0, count: 0 };
    // The descriptors' own derived keys; only the answers are stubbed.
    const pageRead = get("/api/v1/employees"), countRead = get("/api/v1/employees/{id}", { params: { path: { id: "e1" } } });
    const page = new QueryObserver(qc, { ...pageRead, queryFn: () => ++calls.page });
    const count = new QueryObserver(qc, { ...countRead, queryFn: () => ++calls.count, meta: { background: true } });
    const stop = [page.subscribe(() => undefined), count.subscribe(() => undefined)];
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual({ page: 1, count: 1 });
    // A command re-reads the page at once; the count is only marked stale.
    void invalidatePaths(qc, ["/api/v1/employees"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual({ page: 2, count: 1 });
    expect(count.getCurrentResult().isStale).toBe(true);
    // A second invalidation before the wait ends (the live stream's echo) starts the wait again.
    await vi.advanceTimersByTimeAsync(BACKGROUND_SETTLE_MS - 20);
    void invalidateWhere(qc, (path) => path.startsWith("/api/v1/employees"));
    await vi.advanceTimersByTimeAsync(BACKGROUND_SETTLE_MS - 10);
    expect(calls.count).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(calls.count).toBe(2);
    stop.forEach((off) => off());
  } finally { vi.useRealTimers(); }
});

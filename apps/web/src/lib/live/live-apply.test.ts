// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { notifyManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import type { StreamOptions } from "@console/api/events";
import { get } from "../query";
import { closeLive, holdLive, liveApplying, liveHeld, openLive, showHeld } from "./live";

let qc: QueryClient;
let options: StreamOptions;
const frame = (event: string, data: unknown) => options.onFrame({ event, data });
beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient();
  openLive(qc, "http://test/api/v1/events", input => {
    options = input;
    return { get: () => ({ state: "live", since: 0, lastEventAt: null, partial: [] }), subscribe: () => () => {}, lastEventId: "", close: () => {}, reconnect: () => {} };
  });
});
afterEach(() => { closeLive(); qc.clear(); vi.useRealTimers(); });

test.each([false, true])("a held refresh stays applying until its refetch settles (failure: %s)", async (failed) => {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const deferred = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  const refetch = vi.spyOn(qc, "refetchQueries").mockReturnValueOnce(deferred);
  const changed = vi.fn();
  const off = liveApplying.subscribe(changed);
  try {
    const applying = showHeld();
    expect(liveApplying.get()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(liveApplying.get()).toBe(true);
    if (failed) {
      const error = new Error("refresh unavailable");
      reject(error);
      await expect(applying).rejects.toBe(error);
    } else {
      resolve();
      await Promise.resolve();
      // Still applying until the screens have heard the refetch (one notify tick).
      expect(liveApplying.get()).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      await applying;
    }
    expect(liveApplying.get()).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(refetch).toHaveBeenCalledTimes(1);
  } finally {
    off();
    refetch.mockRestore();
  }
});

test("a second refresh preserves newly held changes while the first refresh is applying", async () => {
  let resolve!: () => void;
  const deferred = new Promise<void>((yes) => { resolve = yes; });
  const refetch = vi.spyOn(qc, "refetchQueries").mockReturnValueOnce(deferred);
  const release = holdLive(true);
  try {
    frame("change", { type: "employee", id: "e1" });
    await vi.advanceTimersByTimeAsync(250);
    expect(liveHeld.get()).toBe(1);
    const applying = showHeld();
    expect(liveHeld.get()).toBe(0);
    frame("change", { type: "employee", id: "e2" });
    await vi.advanceTimersByTimeAsync(250);
    await showHeld();
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(liveHeld.get()).toBe(1);
    expect(liveApplying.get()).toBe(true);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    await applying;
    expect(liveApplying.get()).toBe(false);
    expect(liveHeld.get()).toBe(1);
  } finally {
    closeLive();
    release();
    refetch.mockRestore();
  }
});

test("own-write echoes refresh the inbox without increasing a notice hold", async () => {
  const release = holdLive(true);
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  qc.getMutationCache().build(qc, {}).state.status = "pending";
  try {
    frame("change", { type: "employee", id: "e1" });
    await vi.advanceTimersByTimeAsync(250);
    expect(liveHeld.get()).toBe(0);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ refetchType: "active" }));
  } finally { release(); }
});

test("the held refresh stays applying until the shown reads have published their new data", async () => {
  const inbox = get("/api/v1/me/action-inbox", { params: { query: {} } });
  let items = ["undated"];
  const observer = new QueryObserver(qc, { ...inbox, queryFn: async () => ({ items }) as never });
  // A screen hears its observer through notifyManager.batchCalls (as useQuery subscribes), a task after the cache took it.
  const published: unknown[] = [];
  const off = observer.subscribe(notifyManager.batchCalls((r: { data: unknown }) => published.push(r.data)));
  await vi.advanceTimersByTimeAsync(0);
  const release = holdLive(true);
  let paintedWhenApplied: unknown;
  const offApplying = liveApplying.subscribe(() => { if (!liveApplying.get()) paintedWhenApplied = published.at(-1); });
  try {
    items = ["dated", "undated"];
    frame("change", { type: "employee", id: "e1" });
    await vi.advanceTimersByTimeAsync(250);
    const applying = showHeld();
    await vi.advanceTimersByTimeAsync(0);
    await applying;
    expect(liveApplying.get()).toBe(false);
    // Clearing first would remount the list from the old pages, then insert the new group a task later.
    expect(paintedWhenApplied).toEqual({ items: ["dated", "undated"] });
  } finally {
    offApplying();
    off();
    release();
  }
});

test("a stream gap on a held dashboard refetches current appearance and preserves the dashboard snapshot", async () => {
  const release = holdLive(true);
  const workspace = vi.fn(async () => ({ layout: {} }));
  const employee = vi.fn(async () => ({} as never));
  const unwatchWorkspace = new QueryObserver(qc, { ...get("/api/v1/me/workspace"), queryFn: workspace }).subscribe(() => {});
  const unwatchEmployee = new QueryObserver(qc, { ...get("/api/v1/employees"), queryFn: employee }).subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    workspace.mockClear();
    employee.mockClear();
    frame("reset", { reason: "gap" });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(workspace).toHaveBeenCalledOnce();
    expect(employee).not.toHaveBeenCalled();
    expect(liveHeld.get()).toBe(1);
  } finally {
    unwatchWorkspace();
    unwatchEmployee();
    release();
  }
});

test.each(["reset", "change"] as const)("a held view refreshes module access on a tenant policy %s", async event => {
  const release = holdLive(true);
  const grants = vi.fn(async () => ({ capabilities: [] }));
  const stop = new QueryObserver(qc, { ...get("/api/v1/me/authz"), queryFn: grants }).subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    grants.mockClear();
    frame(event, event === "reset" ? { reason: "gap" } : { type: "tenant_settings" });
    await vi.advanceTimersByTimeAsync(11_000);
    expect(grants).toHaveBeenCalledOnce();
  } finally {
    stop();
    release();
  }
});

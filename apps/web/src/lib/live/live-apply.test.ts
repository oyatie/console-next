// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { StreamOptions } from "@console/api/events";
import { closeLive, holdLive, liveApplying, liveHeld, openLive, showHeld } from "./live";

let qc: QueryClient;
let options: StreamOptions;
const frame = (event: string, data: unknown) => options.onFrame({ event, data });
beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient();
  openLive(qc, "http://test/api/v1/events", input => {
    options = input;
    return { get: () => ({ state: "live", since: 0, partial: [] }), subscribe: () => () => {}, lastEventId: "", close: () => {}, reconnect: () => {} };
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

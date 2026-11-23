// SPDX-License-Identifier: LicenseRef-Proprietary
import type { EventStream, StreamOptions, StreamSnapshot } from "@console/api/events";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";
import type { OpsHomeSnapshot } from "./api";
import { applyOpsEventToCache, OpsLiveController } from "./live-sse";

function createFakeStream() {
  let snap: StreamSnapshot = { state: "connecting", since: Date.now(), lastEventAt: null, partial: [] };
  const listeners = new Set<() => void>();
  let onFrame: StreamOptions["onFrame"] | undefined;
  const open = (opts: StreamOptions): EventStream => {
    onFrame = opts.onFrame;
    return {
      get: () => snap,
      subscribe(l) {
        listeners.add(l);
        return () => void listeners.delete(l);
      },
      get lastEventId() {
        return "";
      },
      reconnect() {},
      close() {
        snap = { ...snap, state: "offline" };
        listeners.forEach((l) => l());
      },
    };
  };
  return {
    open,
    setState(state: StreamSnapshot["state"]) {
      snap = { ...snap, state };
      listeners.forEach((l) => l());
    },
    emit(event: string, data: unknown) {
      onFrame?.({ event, data });
    },
  };
}

function sampleHome(text: string): OpsHomeSnapshot {
  return {
    evaluated_at: "2026-11-21T21:45:00Z",
    verdict: { text, worst: "Healthy" },
    worklist: [],
    changing: [],
    budgets: [],
    data_safety: [],
    cost: [],
    evidence: {
      counts: { Verified: 5, Monitoring: 0, Stale: 0, Unknown: 0 },
      sources: [],
    },
  };
}

describe("ops SSE cache updates and pause/resync semantics", () => {
  test("applyOpsEventToCache updates home snapshot and triggers one-shot refetch on resync", () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
    const home = sampleHome("All quiet · 0 pages · evidence fresh");

    applyOpsEventToCache(qc, {
      type: "home.changed",
      id: 1,
      evaluated_at: "2026-11-21T21:45:00Z",
      home,
    });
    expect(qc.getQueryData(["ops", "home"])).toEqual(home);

    applyOpsEventToCache(qc, {
      type: "resync",
      id: 2,
      evaluated_at: "2026-11-21T21:46:00Z",
    });
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ops"], refetchType: "active" });
  });

  test("OpsLiveController stays Reconnecting while connecting or failing initial connect and becomes Live only when live", () => {
    const qc = new QueryClient();
    const fake = createFakeStream();
    const controller = new OpsLiveController(qc, fake.open);
    const stop = controller.start();

    expect(controller.getSnapshot().status).toBe("Reconnecting");
    expect(controller.getSnapshot().disconnectedAgeS).toBeGreaterThanOrEqual(1);

    fake.setState("live");
    expect(controller.getSnapshot().status).toBe("Live");
    expect(controller.getSnapshot().disconnectedAgeS).toBe(0);

    controller.togglePause();
    expect(controller.getSnapshot().paused).toBe(true);
    expect(controller.getSnapshot().status).toBe("Paused");
    controller.showHeld();
    expect(controller.getSnapshot().paused).toBe(false);
    expect(controller.getSnapshot().status).toBe("Live");

    fake.setState("connecting");
    expect(controller.getSnapshot().status).toBe("Reconnecting");
    fake.setState("offline");
    expect(controller.getSnapshot().status).toBe("Offline");
    stop();
  });

  test("applyOpsEventToCache safely ignores malformed JSON objects without throwing", () => {
    const qc = new QueryClient();
    expect(() => applyOpsEventToCache(qc, null)).not.toThrow();
    expect(() => applyOpsEventToCache(qc, [1, 2, 3])).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "home.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "alert.group.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "alert.group.resolved", group: { noKey: 1 } })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "component.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "job.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "source.changed", bad: true })).not.toThrow();
  });
});

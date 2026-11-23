// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test, vi } from "vitest";
import type { OpsHomeSnapshot, OpsIncidentsList, OpsObligationsList } from "./api";
import { applyOpsEventToCache } from "./live-sse";

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

describe("ops OC1 SSE cache updates and home.changed poisoning guard", () => {
  test("applyOpsEventToCache handles OC1 SSE event types and invalidates affected queries", () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    qc.setQueryData<OpsObligationsList>(["ops", "obligations", {}], {
      evaluated_at: "2026-11-21T21:45:00Z",
      verdict: { text: "Blocked", worst: "Degraded" },
      launch_readiness: { text: "Blocked", worst: "Degraded" },
      items: [],
      count: { state: "Verified", value: 0, unit: null, source: "obligations", observed_at: "2026-11-21T21:45:00Z", age_s: 1 },
      sources: [],
    });
    applyOpsEventToCache(qc, {
      type: "obligation.changed",
      id: 2,
      evaluated_at: "2026-11-21T21:46:00Z",
      item: {
        id: "OBL-1",
        kind: "launch-gate",
        reviewer_role: "owner",
        title: "Gate 1",
        due: "2026-11-25",
        state: "done",
        evidence_ref: "ref-1",
        signer: "owner",
        signed_on: "2026-11-21",
        deadline: "D-4",
      },
    });
    expect(qc.getQueryData<OpsObligationsList>(["ops", "obligations", {}])?.items).toHaveLength(1);

    qc.setQueryData<OpsIncidentsList>(["ops", "incidents"], {
      evaluated_at: "2026-11-21T21:45:00Z",
      incidents: [],
      count: { state: "Verified", value: 0, unit: null, source: "incidents", observed_at: "2026-11-21T21:45:00Z", age_s: 1 },
    });
    applyOpsEventToCache(qc, {
      type: "incident.changed",
      id: 3,
      evaluated_at: "2026-11-21T21:46:00Z",
      incident: { id: "INC-0001", title: "API 5xx", sev: "SEV2", status: "Investigating", lead: null, head_seq: 1, next_public_update_at: null, legal_clocks: [] },
    });
    expect(qc.getQueryData<OpsIncidentsList>(["ops", "incidents"])?.incidents).toHaveLength(1);

    applyOpsEventToCache(qc, {
      type: "action.changed",
      id: 4,
      evaluated_at: "2026-11-21T21:46:00Z",
      action: { action_id: "ACT-0001", kind: "backup", command: "tb backup", target: "all", consequence: "c", expected_result: "e", verify_step: "v", operator: "op", at: "2026-11-21T21:46:00Z" },
    });
    applyOpsEventToCache(qc, { type: "silence.changed", id: 5, evaluated_at: "2026-11-21T21:46:00Z", silence_id: "sil-1", active: true });
    applyOpsEventToCache(qc, { type: "promotion.changed", id: 6, evaluated_at: "2026-11-21T21:46:00Z", digest: "sha256:abc" });
    applyOpsEventToCache(qc, { type: "heartbeat", id: 7, evaluated_at: "2026-11-21T21:46:00Z" });

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ops", "actions"], refetchType: "active" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ops", "silences"], refetchType: "active" });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ops", "promote"], refetchType: "active" });
  });

  test("applyOpsEventToCache ignores malformed OC1 payloads and partial home.changed snapshots", () => {
    const qc = new QueryClient();
    const validHome = sampleHome("All quiet · 0 pages · evidence fresh");
    qc.setQueryData(["ops", "home"], validHome);

    expect(() => applyOpsEventToCache(qc, { type: "obligation.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "incident.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "action.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "silence.changed", bad: true })).not.toThrow();
    expect(() => applyOpsEventToCache(qc, { type: "promotion.changed", bad: true })).not.toThrow();

    applyOpsEventToCache(qc, { type: "home.changed", home: { verdict: {} } });
    applyOpsEventToCache(qc, {
      type: "home.changed",
      home: { evaluated_at: "2026-11-21T21:45:00Z", verdict: { text: "ok", worst: "Healthy" } },
    });
    applyOpsEventToCache(qc, {
      type: "home.changed",
      home: { ...validHome, verdict: { text: "ok", worst: "Bogus" } },
    });
    expect(qc.getQueryData(["ops", "home"])).toEqual(validHome);
  });
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import { encodeRunbookSegments } from "./api";
import { readGateStatement, readObligationFields, readOncallConfig, readStatusIncident } from "./api-types";

describe("ops API helpers and narrowed Record<string, never> wrappers", () => {
  test("encodeRunbookSegments preserves slashes and rejects traversal or percent encoding", () => {
    expect(encodeRunbookSegments("RUNBOOK.md")).toBe("RUNBOOK.md");
    expect(encodeRunbookSegments("docs/backup/restore.md")).toBe("docs/backup/restore.md");
    expect(encodeRunbookSegments("/docs/api.md")).toBe("docs/api.md");
    expect(encodeRunbookSegments("../secret.md")).toBeNull();
    expect(encodeRunbookSegments("docs/%2e%2e/secret.md")).toBeNull();
    expect(encodeRunbookSegments("docs\\secret.md")).toBeNull();
    expect(encodeRunbookSegments("")).toBeNull();
  });

  test("narrowed runtime guards validate GateStatement, OncallConfig, StatusIncident, and ObligationFields", () => {
    expect(readGateStatement(null)).toBeNull();
    expect(
      readGateStatement({
        _type: "https://in-toto.io/Statement/v1",
        predicateType: "https://cosskorea.com/attestations/console-gates/v1",
        subject: [{ digest: { sha256: "a".repeat(64) } }],
        predicate: { inputs: {}, gates: [{ name: "ci-ok", result: "pass" }], runner: { kind: "github" }, bake: "normal" },
      })?.predicate.bake,
    ).toBe("normal");

    expect(readOncallConfig({})).toBeNull();
    expect(
      readOncallConfig({
        version: 1,
        mode: "single-operator",
        display_status: "Single operator on call",
        timezone: "Asia/Seoul",
        rotation: { primary_person: null, backup_person: null, handoff_weekday: "Mon", handoff_hour_local: 9 },
        escalation: { ack_timeout_s: 300, repeat_interval_s: 900, out_of_hours_policy: "sev1-symptoms-only", daily_page_budget: 2 },
        synthetic_page_test: { enabled: true, schedule: "weekly", weekday: "Wed", hour_utc: 2, max_delivery_lag_s: 120 },
      })?.timezone,
    ).toBe("Asia/Seoul");

    expect(readStatusIncident(null)).toBeNull();
    expect(
      readStatusIncident({
        id: "ST-0001",
        title: { ko: "API Outage (ko)", en: "API Outage" },
        started_at: "2026-11-21T21:00:00Z",
        report_url: null,
        updates: [],
      })?.id,
    ).toBe("ST-0001");

    expect(readObligationFields({ reason: "Approved" }).reason).toBe("Approved");
    expect(readObligationFields(null)).toEqual({});

    // Negative tests for malformed Record<string, never> payloads
    expect(readGateStatement({ _type: "x", predicateType: "y", subject: [], predicate: { inputs: {}, gates: [], bake: "normal" } })).toBeNull();
    expect(readGateStatement({ _type: "x", predicateType: "y", subject: [], predicate: { inputs: {}, gates: [null], runner: { kind: "gh" }, bake: "normal" } })).toBeNull();
    expect(readGateStatement({ _type: "x", predicateType: "y", subject: [], predicate: { inputs: {}, gates: [], runner: { kind: "gh" } } })).toBeNull();
    expect(readOncallConfig({ rotation: {}, escalation: {}, synthetic_page_test: {} })).toBeNull();
    expect(readStatusIncident({ id: "ST-1", title: { ko: "x" }, started_at: "2026-11-21T00:00:00Z", report_url: null, updates: [{}] })).toBeNull();
    expect(readStatusIncident({ id: "ST-1", title: { ko: "x" }, started_at: "2026-11-21T00:00:00Z", report_url: null, updates: [null] })).toBeNull();
    expect(readObligationFields({ reason: { nested: "object" }, note: 123, title: "Safe" })).toEqual({
      title: "Safe",
      due: undefined,
      evidence_ref: undefined,
      note: undefined,
      reason: undefined,
      signer: undefined,
      signed_on: undefined,
    });
  });
});

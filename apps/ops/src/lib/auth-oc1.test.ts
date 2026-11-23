// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import { OpsApiError } from "./api";
import {
  classifyMutationError,
  classifyOpsError,
  formatOpsErrorCode,
  hasAnyWriteAction,
  hasOpsAction,
  OPS_VALID_ACTIONS,
  sanitizeRawTokens,
} from "./auth";

const ALL_31_REFUSAL_CODES = [
  "OPS_ACCESS_JWT_MISSING", "OPS_ACCESS_JWT_INVALID", "OPS_ACCESS_AUD_MISMATCH",
  "OPS_NOT_OPERATOR", "OPS_GRANT_NOT_LIVE", "OPS_ACTION_DENIED", "OPS_CONFIG_INVALID",
  "OPS_NOT_FOUND", "OPS_TIMEOUT", "OPS_RECORD_CHAIN_BROKEN", "OPS_RECORD_WRITE_FAILED",
  "OPS_ALERT_ACK_INVALID", "OPS_SILENCE_INVALID", "OPS_SILENCE_TTL_EXCEEDED",
  "OPS_WATCHDOG_UNSILENCEABLE", "OPS_UPSTREAM_FAILED", "OPS_INCIDENT_INVALID",
  "OPS_INCIDENT_NOT_FOUND", "OPS_INCIDENT_CONFLICT", "OPS_POSTMORTEM_REQUIRED",
  "OPS_INCIDENT_FINAL", "OPS_OBLIGATION_INVALID", "OPS_OBLIGATION_INCOMPLETE",
  "OPS_OBLIGATION_FINAL", "OPS_OBLIGATION_NOT_FOUND", "OPS_RUNBOOK_NOT_FOUND",
  "bad_request", "not_found", "method_not_allowed", "internal", "origin_refused",
] as const;

describe("ops Cedar gating and OC1 error classification", () => {
  test("hasOpsAction and hasAnyWriteAction check all 54 OPS_VALID_ACTIONS strictly", () => {
    expect(OPS_VALID_ACTIONS).toHaveLength(54);
    const readOnlyMe = {
      evaluated_at: "2026-11-21T21:43:00Z",
      operator: { person: "00000000-0000-4000-8000-000000000001", display_email: "ops@example.com" },
      grants: [],
      allowed_actions: [
        "read.me", "read.home", "read.alerts", "read.running", "read.sources",
        "obligation.read", "support.read", "recovery.read", "tenant.read",
      ],
    };
    expect(hasOpsAction(readOnlyMe, "read.home")).toBe(true);
    expect(hasOpsAction(readOnlyMe, "obligation.read")).toBe(true);
    expect(hasOpsAction(readOnlyMe, "support.read")).toBe(true);
    expect(hasOpsAction(readOnlyMe, "recovery.read")).toBe(true);
    expect(hasOpsAction(readOnlyMe, "tenant.read")).toBe(true);
    expect(hasOpsAction(readOnlyMe, "obligation.write")).toBe(false);
    expect(hasOpsAction(readOnlyMe, "alert.ack")).toBe(false);
    expect(hasAnyWriteAction(readOnlyMe)).toBe(false);

    for (const writeAction of [
      "obligation.write",
      "alert.ack",
      "incident.write",
      "promotion.signoff",
      "review.signoff",
      "feedback.triage",
      "jobs.rerun",
      "breakglass.request",
      "support.writable",
      "recovery.request",
      "recovery.backup",
      "recovery.drill",
      "tenant.destroy",
      "change.request.promote",
    ] as const) {
      const writeMe = { ...readOnlyMe, allowed_actions: [...readOnlyMe.allowed_actions, writeAction] };
      expect(hasOpsAction(writeMe, writeAction)).toBe(true);
      expect(hasAnyWriteAction(writeMe)).toBe(true);
    }
  });

  test("all 31 RefusalCodes map cleanly with zero SCREAMING_SNAKE_CASE leaks", () => {
    expect(ALL_31_REFUSAL_CODES).toHaveLength(31);
    const upperSnake = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
    for (const rawCode of ALL_31_REFUSAL_CODES) {
      const formatted = formatOpsErrorCode(rawCode);
      expect(formatted.code).not.toMatch(upperSnake);
      expect(formatted.reason).not.toMatch(upperSnake);
      expect(formatted.reason.length).toBeGreaterThan(3);

      const err = new OpsApiError(400, {
        code: rawCode,
        message: `Refused with ${rawCode}`,
        support_ref: "sup-test",
        evaluated_at: "2026-11-21T21:43:00Z",
      });
      const mutModel = classifyMutationError(err);
      expect(mutModel.code).toBe(formatted.code);
      expect(mutModel.message).not.toMatch(upperSnake);
    }
  });

  test("sanitizeRawTokens scrubs digit-containing and single-letter SCREAMING_SNAKE_CASE tokens", () => {
    const raw = "Rejected by SEV1_OVERRIDE and A_BAD_TOKEN / E_ACCESS / X_1";
    const expected = "Rejected by sev1-override and a-bad-token / e-access / x-1";
    expect(sanitizeRawTokens(raw)).toBe(expected);

    const err = new OpsApiError(403, {
      code: "OPS_ACTION_DENIED",
      message: raw,
      support_ref: "ref-tok",
      evaluated_at: "2026-11-21T21:43:00Z",
    });
    expect(classifyOpsError(err).message).toBe(expected);
    expect(classifyMutationError(err).message).toBe(expected);
  });

  test("classifyOpsError handles OC1 refusal codes (runbook 404 and broken chain 503)", () => {
    const err404 = new OpsApiError(404, {
      code: "OPS_RUNBOOK_NOT_FOUND",
      message: "Runbook missing.",
      support_ref: "ref-404",
      evaluated_at: "2026-11-21T21:43:00Z",
    });
    expect(classifyOpsError(err404)).toMatchObject({ kind: "404", code: "ops-runbook-not-found", canRetry: false });

    const err503 = new OpsApiError(503, {
      code: "OPS_RECORD_CHAIN_BROKEN",
      message: "Chain broken.",
      support_ref: "ref-503",
      evaluated_at: "2026-11-21T21:43:00Z",
    });
    expect(classifyOpsError(err503)).toMatchObject({ kind: "503", code: "ops-record-chain-broken", showBreakGlass: true });
  });

  test("classifyMutationError flags conflict, postmortem gate, watchdog, and 403 refusals", () => {
    const conflict = classifyMutationError(
      new OpsApiError(409, {
        code: "OPS_INCIDENT_CONFLICT",
        message: "Sequence mismatch",
        support_ref: "ref-409",
        evaluated_at: "2026-11-21T21:43:00Z",
      }),
    );
    expect(conflict.isConflict).toBe(true);
    expect(conflict.isRefusal).toBe(false);

    const postmortem = classifyMutationError(
      new OpsApiError(409, {
        code: "OPS_POSTMORTEM_REQUIRED",
        message: "Postmortem needed",
        support_ref: "ref-pm",
        evaluated_at: "2026-11-21T21:43:00Z",
      }),
    );
    expect(postmortem.isPostmortemRequired).toBe(true);

    const watchdog = classifyMutationError(
      new OpsApiError(422, {
        code: "OPS_WATCHDOG_UNSILENCEABLE",
        message: "Watchdog cannot be silenced",
        support_ref: "ref-wd",
        evaluated_at: "2026-11-21T21:43:00Z",
      }),
    );
    expect(watchdog.isWatchdog).toBe(true);

    const originRefused = classifyMutationError(
      new OpsApiError(403, {
        code: "origin_refused",
        message: "Origin refused",
        support_ref: "ref-orig",
        evaluated_at: "2026-11-21T21:43:00Z",
      }),
    );
    expect(originRefused.isRefusal).toBe(true);
  });
});

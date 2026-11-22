// SPDX-License-Identifier: LicenseRef-Proprietary
import { describe, expect, test } from "vitest";
import { OpsApiError } from "./api";
import { classifyOpsError, formatOpsErrorCode, hasOpsAction } from "./auth";

describe("ops Cedar gating and O0 error classification", () => {
  test("hasOpsAction checks allowed_actions strictly", () => {
    const me = {
      evaluated_at: "2026-11-21T21:43:00Z",
      operator: { person: "00000000-0000-4000-8000-000000000001", display_email: "ops@example.com" },
      grants: [],
      allowed_actions: ["read.me", "read.home", "read.sources"],
    };
    expect(hasOpsAction(me, "read.home")).toBe(true);
    expect(hasOpsAction(me, "read.sources")).toBe(true);
    expect(hasOpsAction(me, "read.alerts")).toBe(false);
    expect(hasOpsAction(me, "read.running")).toBe(false);
    expect(hasOpsAction(undefined, "read.home")).toBe(false);
  });

  test("classifyOpsError distinguishes 401, 403, 404, and 503 with mapped codes, reasons, support_ref, and evaluated_at", () => {
    const err401 = new OpsApiError(401, {
      code: "OPS_ACCESS_JWT_MISSING",
      message: "Access assertion header missing.",
      support_ref: "ref-401",
      evaluated_at: "2026-11-21T21:43:00Z",
    });
    expect(classifyOpsError(err401)).toMatchObject({
      kind: "401",
      code: "ops-access-jwt-missing",
      reason: "Access token missing",
      supportRef: "ref-401",
      evaluatedAt: "2026-11-21T21:43:00Z",
      canRetry: true,
    });

    const err403 = new OpsApiError(403, {
      code: "OPS_NOT_OPERATOR",
      message: "Principal has no active ops operator grant.",
      support_ref: "ref-403",
      evaluated_at: "2026-11-21T21:43:00Z",
    });
    expect(classifyOpsError(err403)).toMatchObject({
      kind: "403",
      code: "ops-not-operator",
      reason: "Operator grant required",
      supportRef: "ref-403",
      canRetry: false,
    });

    const err404 = new OpsApiError(404, {
      code: "OPS_NOT_FOUND",
      message: "Alert group was not found in current snapshot.",
      support_ref: "ref-404",
      evaluated_at: "2026-11-21T21:43:00Z",
    });
    expect(classifyOpsError(err404)).toMatchObject({
      kind: "404",
      code: "ops-not-found",
      reason: "Resource not found",
      supportRef: "ref-404",
      evaluatedAt: "2026-11-21T21:43:00Z",
      showBreakGlass: false,
      canRetry: false,
    });

    const err503 = new OpsApiError(503, {
      code: "OPS_TIMEOUT",
      message: "Backend timed out.",
      support_ref: "ref-503",
      evaluated_at: "2026-11-21T21:43:00Z",
    });
    expect(classifyOpsError(err503)).toMatchObject({
      kind: "503",
      code: "ops-timeout",
      reason: "Gateway timeout",
      supportRef: "ref-503",
      showBreakGlass: true,
      canRetry: true,
    });

    expect(formatOpsErrorCode("HTTP_502")).toEqual({
      code: "http-502",
      reason: "HTTP 502 error",
    });
    expect(formatOpsErrorCode("OPS_CUSTOM_ERROR")).toEqual({
      code: "ops-custom-error",
      reason: "Ops custom error",
    });
  });
});

// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, assertBoundPasskey, unwrap, type components } from "@console/api";
import type {
  PrivacyDecisionInput,
  PrivacyOffAppReceipt,
  PrivacyObjectionInput,
  PrivacyPostponeInput,
} from "@console/api/pending";
import { isMessageId, t } from "@console/i18n";
import { STALE_TIME_MS } from "../../../lib/freshness";
import { cursorPages, get } from "../../../lib/query";

export { ApiError };

export type PrivacyRightKind = PrivacyDecisionInput["kind"];
export type PrivacyOutcome = PrivacyDecisionInput["outcome"];
export type WirePrivacyReceipt = components["schemas"]["PrivacyRightsReceipt"];

export const privacyIntakeListPages = (status?: "RECEIVED" | "DECIDED") =>
  cursorPages("/api/v1/privacy/rights-requests", status ? { status } : {});

export const privacyIntakeDetailQuery = (id: string) =>
  get("/api/v1/privacy/rights-requests/{id}", { params: { path: { id } } });

export const privacyReasonCodesQuery = (domain: string) => ({
  ...get("/api/v1/reason-codes", { params: { query: { domain } } }),
  staleTime: STALE_TIME_MS,
  retry: false as const,
});

export function privacyRefusalReasonDomain(kind: PrivacyRightKind): string | null {
  switch (kind) {
    case "ACCESS":
      return "privacy_refusal_access";
    case "DELETION":
      return "privacy_refusal_deletion";
    case "SUSPENSION":
      return "privacy_refusal_suspension";
    case "CORRECTION":
    case "WITHDRAWAL":
      return null;
  }
}

export function privacyOutcomeSupported(kind: PrivacyRightKind, outcome: PrivacyOutcome): boolean {
  if (kind === "CORRECTION" && outcome !== "GRANTED") return false;
  return true;
}

/** Exact JSON key order required by backend `PRIVACY_REQUEST_DECIDE` step-up binding. */
function serializePrivacyDecisionPayload(input: PrivacyDecisionInput): string {
  return JSON.stringify({
    kind: input.kind,
    outcome: input.outcome,
    reason: input.reason ?? null,
    note: input.note ?? null,
    decided_on: input.decided_on ?? null,
  });
}

/** Exact JSON key order required by backend `PRIVACY_REQUEST_DECIDE` postpone step-up binding. */
function serializePrivacyPostponePayload(input: PrivacyPostponeInput): string {
  return JSON.stringify({
    kind: input.kind,
    reason: input.reason,
    note: input.note,
    decided_on: input.decided_on ?? null,
  });
}

export function receiveOffAppPrivacyRequest(input: PrivacyOffAppReceipt, key: string) {
  return unwrap(
    api.POST("/api/v1/privacy/rights-requests/received", {
      params: { header: { "Idempotency-Key": key } },
      body: input,
    }),
  );
}

export async function decidePrivacyRequest(id: string, input: PrivacyDecisionInput, key: string) {
  const step_up = await assertBoundPasskey(
    "PRIVACY_REQUEST_DECIDE",
    id,
    serializePrivacyDecisionPayload(input),
  );
  return unwrap(
    api.POST("/api/v1/privacy/rights-requests/{id}/decide", {
      params: { path: { id }, header: { "Idempotency-Key": key } },
      body: { ...input, step_up },
    }),
  );
}

export async function postponePrivacyRequest(id: string, input: PrivacyPostponeInput, key: string) {
  const step_up = await assertBoundPasskey(
    "PRIVACY_REQUEST_DECIDE",
    id,
    serializePrivacyPostponePayload(input),
  );
  return unwrap(
    api.POST("/api/v1/privacy/rights-requests/{id}/postpone", {
      params: { path: { id }, header: { "Idempotency-Key": key } },
      body: { ...input, step_up },
    }),
  );
}

export function objectPrivacyRequest(id: string, input: PrivacyObjectionInput, key: string) {
  return unwrap(
    api.POST("/api/v1/privacy/rights-requests/{id}/objection", {
      params: { path: { id }, header: { "Idempotency-Key": key } },
      body: input,
    }),
  );
}

export function privacyLifecycleError(error: unknown): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  if (error.code === "privacy.refuse.identity_unbound") {
    return t("privacy.refuse.identity_unbound");
  }
  const key = `privacy.err.${error.code}`;
  return isMessageId(key) ? t(key) : undefined;
}

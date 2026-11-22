// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";
import { OpsApiError, type OpsMe } from "./api";

export type OpsAction = "read.me" | "read.home" | "read.alerts" | "read.running" | "read.sources";

export function hasOpsAction(me: OpsMe | undefined, action: OpsAction): boolean {
  if (!me) return false;
  return me.allowed_actions.includes(action);
}

export type RefusalModel = {
  kind: "401" | "403" | "404" | "503";
  title: string;
  guidance: string;
  code: string;
  reason: string;
  message: string;
  supportRef: string;
  evaluatedAt: string;
  showBreakGlass: boolean;
  canRetry: boolean;
};

const KNOWN_ERROR_MAP: Record<string, { code: string; reason: string }> = {
  OPS_ACCESS_JWT_MISSING: { code: "ops-access-jwt-missing", reason: COPY.o0.reasons.accessMissing },
  OPS_ACCESS_JWT_INVALID: { code: "ops-access-jwt-invalid", reason: COPY.o0.reasons.accessInvalid },
  OPS_ACCESS_AUD_MISMATCH: { code: "ops-access-aud-mismatch", reason: COPY.o0.reasons.accessAudMismatch },
  OPS_NOT_OPERATOR: { code: "ops-not-operator", reason: COPY.o0.reasons.notOperator },
  OPS_GRANT_NOT_LIVE: { code: "ops-grant-not-live", reason: COPY.o0.reasons.grantNotLive },
  OPS_ACTION_DENIED: { code: "ops-action-denied", reason: COPY.o0.reasons.actionDenied },
  origin_refused: { code: "origin-refused", reason: COPY.o0.reasons.originRefused },
  OPS_NOT_FOUND: { code: "ops-not-found", reason: COPY.o0.reasons.notFound },
  OPS_TIMEOUT: { code: "ops-timeout", reason: COPY.o0.reasons.timeout },
  OPS_CONFIG_INVALID: { code: "ops-config-invalid", reason: COPY.o0.reasons.configInvalid },
};

export function formatOpsErrorCode(rawCode: string): { code: string; reason: string } {
  const mapped = KNOWN_ERROR_MAP[rawCode];
  if (mapped) return mapped;
  const httpMatch = /^HTTP_(\d+)$/.exec(rawCode.trim());
  if (httpMatch) {
    return {
      code: `http-${httpMatch[1]}`,
      reason: `${COPY.o0.httpStatusPrefix} ${httpMatch[1]} error`,
    };
  }
  const normalized =
    rawCode
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-|-$/g, "") || "ops-error";
  const words = normalized.replace(/-/g, " ").trim();
  const reason = words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : COPY.o0.reasons.unavailable;
  return { code: normalized, reason };
}

export function classifyOpsError(error: unknown): RefusalModel {
  const err = error instanceof OpsApiError
    ? error
    : new OpsApiError(503, {
        code: "OPS_TIMEOUT",
        message: error instanceof Error ? error.message : COPY.o0.unreachableGuidance,
        support_ref: "unavailable",
        evaluated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });

  const { code, reason } = formatOpsErrorCode(err.code);

  if (err.status === 401 || err.code.startsWith("OPS_ACCESS_JWT") || err.code === "OPS_ACCESS_AUD_MISMATCH") {
    const title = err.code === "OPS_ACCESS_AUD_MISMATCH"
      ? COPY.o0.accessAudTitle
      : err.code === "OPS_ACCESS_JWT_INVALID"
        ? COPY.o0.accessInvalidTitle
        : COPY.o0.accessMissingTitle;
    return {
      kind: "401",
      title,
      guidance: COPY.o0.accessGuidance,
      code,
      reason,
      message: err.message,
      supportRef: err.supportRef,
      evaluatedAt: err.evaluatedAt,
      showBreakGlass: false,
      canRetry: true,
    };
  }

  if (err.status === 403 || err.code === "OPS_NOT_OPERATOR" || err.code === "OPS_GRANT_NOT_LIVE" || err.code === "OPS_ACTION_DENIED" || err.code === "origin_refused") {
    const title = err.code === "OPS_GRANT_NOT_LIVE"
      ? COPY.o0.grantNotLiveTitle
      : err.code === "OPS_ACTION_DENIED"
        ? COPY.o0.actionDeniedTitle
        : err.code === "origin_refused"
          ? COPY.o0.originRefusedTitle
          : COPY.o0.notOperatorTitle;
    return {
      kind: "403",
      title,
      guidance: COPY.o0.whoCanGrant,
      code,
      reason,
      message: err.message,
      supportRef: err.supportRef,
      evaluatedAt: err.evaluatedAt,
      showBreakGlass: false,
      canRetry: false,
    };
  }

  if (err.status === 404 || err.code === "OPS_NOT_FOUND") {
    return {
      kind: "404",
      title: COPY.o0.notFoundTitle,
      guidance: COPY.o0.notFoundGuidance,
      code,
      reason,
      message: err.message,
      supportRef: err.supportRef,
      evaluatedAt: err.evaluatedAt,
      showBreakGlass: false,
      canRetry: false,
    };
  }

  return {
    kind: "503",
    title: COPY.o0.unreachableTitle,
    guidance: COPY.o0.unreachableGuidance,
    code,
    reason,
    message: err.message,
    supportRef: err.supportRef,
    evaluatedAt: err.evaluatedAt,
    showBreakGlass: true,
    canRetry: true,
  };
}

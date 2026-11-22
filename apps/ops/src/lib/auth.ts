// SPDX-License-Identifier: LicenseRef-Proprietary
import { COPY } from "../copy";
import { OpsApiError, type OpsMe } from "./api";

export const OPS_VALID_ACTIONS = [
  "read.me",
  "read.home",
  "read.alerts",
  "read.running",
  "read.sources",
  "obligation.read",
  "obligation.write",
  "alert.ack",
  "alert.silence",
  "incident.write",
  "incident.publish",
  "promotion.signoff",
  "review.signoff",
  "feedback.triage",
  "jobs.rerun",
  "breakglass.request",
  "breakglass.approve",
  "support.read",
  "support.writable",
  "recovery.read",
  "recovery.request",
  "recovery.backup",
  "recovery.drill",
  "tenant.read",
  "tenant.create",
  "tenant.code",
  "tenant.suspend",
  "tenant.reactivate",
  "tenant.export",
  "tenant.close",
  "tenant.destroy",
  "tenant.takeover",
  "change.request.backup-now",
  "change.request.canary-abort",
  "change.request.canary-hold",
  "change.request.canary-promote",
  "change.request.drill",
  "change.request.drill-at",
  "change.request.freeze",
  "change.request.infra-apply",
  "change.request.preview-off",
  "change.request.preview-release",
  "change.request.preview-reset",
  "change.request.promote",
  "change.request.prune",
  "change.request.reboot",
  "change.request.rehearse",
  "change.request.rerender-restart",
  "change.request.retry",
  "change.request.rollback",
  "change.request.rotate",
  "change.request.status-publish",
  "change.request.trace-store-reset",
  "change.request.unfreeze",
] as const;

export type OpsAction = (typeof OPS_VALID_ACTIONS)[number];

const WRITE_ACTION_PREFIXES = [
  "obligation.write",
  "alert.",
  "incident.",
  "promotion.",
  "review.signoff",
  "feedback.",
  "jobs.rerun",
  "breakglass.",
  "support.writable",
  "recovery.request",
  "recovery.backup",
  "recovery.drill",
  "tenant.create",
  "tenant.code",
  "tenant.suspend",
  "tenant.reactivate",
  "tenant.export",
  "tenant.close",
  "tenant.destroy",
  "tenant.takeover",
  "change.request.",
];

export function hasOpsAction(me: OpsMe | undefined, action: OpsAction): boolean {
  if (!me) return false;
  return me.allowed_actions.includes(action);
}

export function hasAnyOpsAction(me: OpsMe | undefined, actions: readonly OpsAction[]): boolean {
  if (!me) return false;
  return actions.some((action) => me.allowed_actions.includes(action));
}

export function hasAnyWriteAction(me: OpsMe | undefined): boolean {
  if (!me) return false;
  return me.allowed_actions.some((a) => WRITE_ACTION_PREFIXES.some((p) => a.startsWith(p)));
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

export type MutationErrorModel = {
  status: number;
  code: string;
  reason: string;
  message: string;
  supportRef: string;
  evaluatedAt: string;
  isConflict: boolean;
  isRefusal: boolean;
  isPostmortemRequired: boolean;
  isWatchdog: boolean;
};

const KNOWN_ERROR_MAP: Record<string, { code: string; reason: string }> = {
  OPS_ACCESS_JWT_MISSING: { code: "ops-access-jwt-missing", reason: COPY.o0.reasons.accessMissing },
  OPS_ACCESS_JWT_INVALID: { code: "ops-access-jwt-invalid", reason: COPY.o0.reasons.accessInvalid },
  OPS_ACCESS_AUD_MISMATCH: { code: "ops-access-aud-mismatch", reason: COPY.o0.reasons.accessAudMismatch },
  OPS_NOT_OPERATOR: { code: "ops-not-operator", reason: COPY.o0.reasons.notOperator },
  OPS_GRANT_NOT_LIVE: { code: "ops-grant-not-live", reason: COPY.o0.reasons.grantNotLive },
  OPS_ACTION_DENIED: { code: "ops-action-denied", reason: COPY.o0.reasons.actionDenied },
  OPS_CONFIG_INVALID: { code: "ops-config-invalid", reason: COPY.o0.reasons.configInvalid },
  origin_refused: { code: "origin-refused", reason: COPY.o0.reasons.originRefused },
  OPS_NOT_FOUND: { code: "ops-not-found", reason: COPY.o0.reasons.notFound },
  OPS_TIMEOUT: { code: "ops-timeout", reason: COPY.o0.reasons.timeout },
  OPS_RECORD_CHAIN_BROKEN: { code: "ops-record-chain-broken", reason: COPY.o0.reasons.recordChainBroken },
  OPS_RECORD_WRITE_FAILED: { code: "ops-record-write-failed", reason: COPY.o0.reasons.recordWriteFailed },
  OPS_UPSTREAM_FAILED: { code: "ops-upstream-failed", reason: COPY.o0.reasons.upstreamFailed },
  OPS_ALERT_ACK_INVALID: { code: "ops-alert-ack-invalid", reason: COPY.o0.reasons.alertAckInvalid },
  OPS_SILENCE_INVALID: { code: "ops-silence-invalid", reason: COPY.o0.reasons.silenceInvalid },
  OPS_SILENCE_TTL_EXCEEDED: { code: "ops-silence-ttl-exceeded", reason: COPY.o0.reasons.silenceTtlExceeded },
  OPS_WATCHDOG_UNSILENCEABLE: { code: "ops-watchdog-unsilenceable", reason: COPY.o0.reasons.watchdogUnsilenceable },
  OPS_INCIDENT_INVALID: { code: "ops-incident-invalid", reason: COPY.o0.reasons.incidentInvalid },
  OPS_INCIDENT_NOT_FOUND: { code: "ops-incident-not-found", reason: COPY.o0.reasons.incidentNotFound },
  OPS_INCIDENT_CONFLICT: { code: "ops-incident-conflict", reason: COPY.o0.reasons.incidentConflict },
  OPS_POSTMORTEM_REQUIRED: { code: "ops-postmortem-required", reason: COPY.o0.reasons.postmortemRequired },
  OPS_INCIDENT_FINAL: { code: "ops-incident-final", reason: COPY.o0.reasons.incidentFinal },
  OPS_OBLIGATION_INVALID: { code: "ops-obligation-invalid", reason: COPY.o0.reasons.obligationInvalid },
  OPS_OBLIGATION_INCOMPLETE: { code: "ops-obligation-incomplete", reason: COPY.o0.reasons.obligationIncomplete },
  OPS_OBLIGATION_FINAL: { code: "ops-obligation-final", reason: COPY.o0.reasons.obligationFinal },
  OPS_OBLIGATION_NOT_FOUND: { code: "ops-obligation-not-found", reason: COPY.o0.reasons.obligationNotFound },
  OPS_RUNBOOK_NOT_FOUND: { code: "ops-runbook-not-found", reason: COPY.o0.reasons.runbookNotFound },
  bad_request: { code: "bad-request", reason: COPY.o0.reasons.badRequest },
  not_found: { code: "not-found", reason: COPY.o0.reasons.notFound },
  method_not_allowed: { code: "method-not-allowed", reason: COPY.o0.reasons.methodNotAllowed },
  internal: { code: "internal", reason: COPY.o0.reasons.internalError },
};

export function sanitizeRawTokens(text: string): string {
  return text.replace(/\b([A-Z][A-Z0-9]*_[A-Z0-9_]+)\b/g, (raw) => formatOpsErrorCode(raw).code);
}

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

function toApiError(error: unknown): OpsApiError {
  if (error instanceof OpsApiError) return error;
  return new OpsApiError(503, {
    code: "OPS_TIMEOUT",
    message: error instanceof Error ? error.message : COPY.o0.unreachableGuidance,
    support_ref: "unavailable",
    evaluated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
}

export function classifyOpsError(error: unknown): RefusalModel {
  const err = toApiError(error);
  const { code, reason } = formatOpsErrorCode(err.code);
  const safeMessage = sanitizeRawTokens(err.message);

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
      message: safeMessage,
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
      message: safeMessage,
      supportRef: err.supportRef,
      evaluatedAt: err.evaluatedAt,
      showBreakGlass: false,
      canRetry: false,
    };
  }

  if (err.status === 404 || err.code === "OPS_NOT_FOUND" || err.code === "OPS_INCIDENT_NOT_FOUND" || err.code === "OPS_OBLIGATION_NOT_FOUND" || err.code === "OPS_RUNBOOK_NOT_FOUND" || err.code === "not_found") {
    return {
      kind: "404",
      title: COPY.o0.notFoundTitle,
      guidance: COPY.o0.notFoundGuidance,
      code,
      reason,
      message: safeMessage,
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
    message: safeMessage,
    supportRef: err.supportRef,
    evaluatedAt: err.evaluatedAt,
    showBreakGlass: true,
    canRetry: true,
  };
}

export function classifyMutationError(error: unknown): MutationErrorModel {
  const err = toApiError(error);
  const { code, reason } = formatOpsErrorCode(err.code);
  return {
    status: err.status,
    code,
    reason,
    message: sanitizeRawTokens(err.message),
    supportRef: err.supportRef,
    evaluatedAt: err.evaluatedAt,
    isConflict: err.code === "OPS_INCIDENT_CONFLICT",
    isRefusal: err.status === 401 || err.status === 403 || err.code === "OPS_ACTION_DENIED" || err.code === "OPS_NOT_OPERATOR" || err.code === "OPS_GRANT_NOT_LIVE" || err.code === "origin_refused",
    isPostmortemRequired: err.code === "OPS_POSTMORTEM_REQUIRED",
    isWatchdog: err.code === "OPS_WATCHDOG_UNSILENCEABLE",
  };
}

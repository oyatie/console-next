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
  message: string;
  supportRef: string;
  evaluatedAt: string;
  showBreakGlass: boolean;
  canRetry: boolean;
};

export function classifyOpsError(error: unknown): RefusalModel {
  const err = error instanceof OpsApiError
    ? error
    : new OpsApiError(503, {
        code: "OPS_TIMEOUT",
        message: error instanceof Error ? error.message : COPY.o0.unreachableGuidance,
        support_ref: "unavailable",
        evaluated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });

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
      code: err.code,
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
      code: err.code,
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
      code: err.code,
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
    code: err.code,
    message: err.message,
    supportRef: err.supportRef,
    evaluatedAt: err.evaluatedAt,
    showBreakGlass: true,
    canRetry: true,
  };
}

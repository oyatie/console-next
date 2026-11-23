// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import type { components, paths } from "@console/api/ops-schema";
import type { IncidentEventPayload, ObligationEventPayload } from "./api-types";

type S = components["schemas"];
export type OpsErrorPayload = S["Error"];
export type OpsHealth = S["Health"];
export type OpsDrift = S["Drift"];
export type OpsEvidenceState = S["EvidenceState"];
export type OpsAlertState = S["AlertState"];
export type OpsSeverity = S["Severity"];
export type OpsJobState = S["JobState"];
export type OpsLive = S["Live"];
export type OpsObligationKind = S["ObligationKind"];
export type OpsObligationReviewerRole = S["ObligationReviewerRole"];
export type OpsObligationState = S["ObligationState"];
export type OpsIncidentSeverity = S["IncidentSeverity"];
export type OpsIncidentStatus = S["Incident"];
export type OpsPersonalDataImpact = S["PersonalDataImpact"];
export type OpsPublicComponent = S["PublicComponent"];
export type OpsPromotion = S["Promotion"];

export type OpsObservation = {
  state: OpsEvidenceState;
  value?: unknown;
  unit: string | null;
  source: string;
  observed_at?: string | null;
  age_s: number;
  reason?: string | null;
};

export function readObservedValue(obs: OpsObservation | undefined): unknown {
  return obs && "value" in obs ? obs.value : undefined;
}

export function readObservedReason(obs: { state: OpsEvidenceState; reason?: string | null } | undefined): string | null {
  return obs && "reason" in obs && typeof obs.reason === "string" ? obs.reason : null;
}

export class OpsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly supportRef: string;
  readonly evaluatedAt: string;

  constructor(status: number, payload: { code: string; message: string; support_ref: string; evaluated_at: string }) {
    super(payload.message);
    this.name = "OpsApiError";
    this.status = status;
    this.code = payload.code;
    this.supportRef = payload.support_ref;
    this.evaluatedAt = payload.evaluated_at;
  }
}

const client = createClient<paths>({ baseUrl: "" });

function nowUtcZ(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function normalizeError(status: number, error: unknown, response?: Response): OpsApiError {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec.code === "string" && typeof rec.message === "string") {
      return new OpsApiError(status, {
        code: rec.code,
        message: rec.message,
        support_ref: typeof rec.support_ref === "string" ? rec.support_ref : "unavailable",
        evaluated_at: typeof rec.evaluated_at === "string" ? rec.evaluated_at : nowUtcZ(),
      });
    }
  }
  const ref = response?.headers.get("x-request-id") ?? "unavailable";
  return new OpsApiError(status, {
    code: status === 503 ? "OPS_TIMEOUT" : `HTTP_${status || 503}`,
    message:
      status === 401
        ? "Cloudflare Access session required."
        : status === 403
          ? "Access refused by ops policy."
          : status === 404
            ? "Requested ops resource was not found."
            : "Ops cockpit backend unreachable.",
    support_ref: ref,
    evaluated_at: nowUtcZ(),
  });
}

async function unwrap<T>(call: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  try {
    const { data, error, response } = await call;
    if (error !== undefined || data === undefined) {
      throw normalizeError(response.status, error, response);
    }
    return data;
  } catch (err) {
    if (err instanceof OpsApiError) throw err;
    throw new OpsApiError(503, {
      code: "OPS_TIMEOUT",
      message: err instanceof Error && err.message ? err.message : "Network connection to ops cockpit failed.",
      support_ref: "client-network",
      evaluated_at: nowUtcZ(),
    });
  }
}

export function encodeRunbookSegments(rawPath: string): string | null {
  const trimmed = rawPath.replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("\\") || trimmed.includes("%")) return null;
  const parts = trimmed.split("/");
  if (parts.some((p) => !p || p === "." || p === "..")) return null;
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

export async function fetchOpsRunbookDoc(path: string): Promise<S["RunbookDocView"]> {
  const encoded = encodeRunbookSegments(path);
  if (!encoded) {
    throw new OpsApiError(404, {
      code: "OPS_RUNBOOK_NOT_FOUND",
      message: "Runbook path is invalid.",
      support_ref: "client-runbook-path",
      evaluated_at: nowUtcZ(),
    });
  }
  try {
    const response = await fetch(`/api/ops/v1/runbooks/${encoded}`, {
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;
    if (!response.ok || !parsed) {
      throw normalizeError(response.status, parsed, response);
    }
    return parsed as S["RunbookDocView"];
  } catch (err) {
    if (err instanceof OpsApiError) throw err;
    throw new OpsApiError(503, {
      code: "OPS_TIMEOUT",
      message: err instanceof Error && err.message ? err.message : "Network connection to ops cockpit failed.",
      support_ref: "client-network",
      evaluated_at: nowUtcZ(),
    });
  }
}

export const opsQueryKeys = {
  me: ["ops", "me"] as const,
  home: ["ops", "home"] as const,
  health: ["ops", "health"] as const,
  alerts: (q: { state?: OpsAlertState; severity?: OpsSeverity; component?: string }) => ["ops", "alerts", q] as const,
  alertDetail: (key: string) => ["ops", "alert", key] as const,
  silences: ["ops", "silences"] as const,
  oncall: ["ops", "oncall"] as const,
  incidents: ["ops", "incidents"] as const,
  incidentDetail: (id: string) => ["ops", "incident", id] as const,
  running: (q: { group?: string; state?: OpsHealth }) => ["ops", "running", q] as const,
  jobs: ["ops", "running", "jobs"] as const,
  changes: ["ops", "changes"] as const,
  promote: ["ops", "promote"] as const,
  actions: ["ops", "actions"] as const,
  runbooks: ["ops", "runbooks"] as const,
  runbookDoc: (path: string) => ["ops", "runbook", path] as const,
  obligations: (q: { kind?: OpsObligationKind; state?: OpsObligationState }) => ["ops", "obligations", q] as const,
  obligationDetail: (id: string) => ["ops", "obligation", id] as const,
  recovery: ["ops", "recovery"] as const,
  sources: ["ops", "sources"] as const,
};

export const fetchOpsMe = () => unwrap(client.GET("/api/ops/v1/me"));
export const fetchOpsHome = () => unwrap(client.GET("/api/ops/v1/home"));
export const fetchOpsHealth = () => unwrap(client.GET("/api/ops/v1/health"));
export const fetchOpsAlerts = (query: { state?: OpsAlertState; severity?: OpsSeverity; component?: string }) =>
  unwrap(client.GET("/api/ops/v1/alerts", { params: { query } }));
export const fetchOpsAlertDetail = (key: string) =>
  unwrap(client.GET("/api/ops/v1/alerts/{key}", { params: { path: { key } } }));
export const fetchOpsSilences = () => unwrap(client.GET("/api/ops/v1/silences"));
export const fetchOpsOncall = () => unwrap(client.GET("/api/ops/v1/oncall"));
export const fetchOpsIncidents = () => unwrap(client.GET("/api/ops/v1/incidents"));
export const fetchOpsIncidentDetail = (id: string) =>
  unwrap(client.GET("/api/ops/v1/incidents/{id}", { params: { path: { id } } }));
export const fetchOpsRunning = (query: { group?: string; state?: OpsHealth }) =>
  unwrap(client.GET("/api/ops/v1/running", { params: { query } }));
export const fetchOpsJobs = () => unwrap(client.GET("/api/ops/v1/running/jobs"));
export const fetchOpsChanges = () => unwrap(client.GET("/api/ops/v1/changes"));
export const fetchOpsPromote = () => unwrap(client.GET("/api/ops/v1/promote"));
export const fetchOpsActions = () => unwrap(client.GET("/api/ops/v1/actions"));
export const fetchOpsRunbooks = () => unwrap(client.GET("/api/ops/v1/runbooks"));
export const fetchOpsObligations = (query: { kind?: OpsObligationKind; state?: OpsObligationState }) =>
  unwrap(client.GET("/api/ops/v1/obligations", { params: { query } }));
export const fetchOpsObligationDetail = (id: string) =>
  unwrap(client.GET("/api/ops/v1/obligations/{id}", { params: { path: { id } } }));
export const fetchOpsRecovery = () => unwrap(client.GET("/api/ops/v1/recovery"));
export const fetchOpsSources = () => unwrap(client.GET("/api/ops/v1/sources"));

export const postOpsAlertAck = (key: string, body: S["AckRequest"]) =>
  unwrap(client.POST("/api/ops/v1/alerts/{key}/ack", { params: { path: { key } }, body }));
export const postOpsSilence = (body: S["SilenceCreateRequest"]) =>
  unwrap(client.POST("/api/ops/v1/silences", { body }));
export const deleteOpsSilence = (id: string) =>
  unwrap(client.DELETE("/api/ops/v1/silences/{id}", { params: { path: { id } } }));
export const postOpsJobRerun = (name: string) =>
  unwrap(client.POST("/api/ops/v1/running/jobs/{name}/rerun", { params: { path: { name } } }));
export const postOpsOncallPageTest = () =>
  unwrap(client.POST("/api/ops/v1/oncall/page-test"));
export const postOpsIncidentDeclare = (body: S["DeclareIncidentRequest"]) =>
  unwrap(client.POST("/api/ops/v1/incidents", { body }));
export const postOpsIncidentEvent = (id: string, body: IncidentEventPayload) =>
  unwrap(client.POST("/api/ops/v1/incidents/{id}/events", {
    params: { path: { id } },
    body: body as unknown as S["IncidentEventRequest"],
  }));
export const postOpsIncidentPublicDraft = (id: string, body: S["PublicDraftRequest"]) =>
  unwrap(client.POST("/api/ops/v1/incidents/{id}/public-draft", { params: { path: { id } }, body }));
export const postOpsChangesRollback = (body: S["RollbackRequest"]) =>
  unwrap(client.POST("/api/ops/v1/changes/rollback", { body }));
export const postOpsChangesCanary = (body: S["CanaryRequest"]) =>
  unwrap(client.POST("/api/ops/v1/changes/canary", { body }));
export const postOpsChangesFreeze = (body: S["FreezeRequest"]) =>
  unwrap(client.POST("/api/ops/v1/changes/freeze", { body }));
export const postOpsPromoteSignoff = (body: S["SignoffRequest"]) =>
  unwrap(client.POST("/api/ops/v1/promote/signoff", { body }));
export const postOpsPromoteFeedback = (body: S["FeedbackRequest"]) =>
  unwrap(client.POST("/api/ops/v1/promote/feedback", { body }));
export const postOpsPromoteRequest = (body: S["PromoteRequest"]) =>
  unwrap(client.POST("/api/ops/v1/promote/request", { body }));
export const postOpsRecoveryBackup = (body: S["BackupRequest"]) =>
  unwrap(client.POST("/api/ops/v1/recovery/backup", { body }));
export const postOpsRecoveryDrill = (body: S["DrillRequest"]) =>
  unwrap(client.POST("/api/ops/v1/recovery/drill", { body }));
export const postOpsObligationOpen = (body: S["OpenObligationRequest"]) =>
  unwrap(client.POST("/api/ops/v1/obligations", { body }));
export const postOpsObligationEvent = (id: string, body: ObligationEventPayload) =>
  unwrap(client.POST("/api/ops/v1/obligations/{id}/events", {
    params: { path: { id } },
    body: body as unknown as S["ObligationEventRequest"],
  }));

export type OpsMe = Awaited<ReturnType<typeof fetchOpsMe>>;
export type OpsHomeSnapshot = Awaited<ReturnType<typeof fetchOpsHome>>;
export type OpsServiceHealth = Awaited<ReturnType<typeof fetchOpsHealth>>;
export type OpsAlertGroups = Awaited<ReturnType<typeof fetchOpsAlerts>>;
export type OpsAlertGroup = OpsAlertGroups["groups"][number];
export type OpsAlertDetail = Awaited<ReturnType<typeof fetchOpsAlertDetail>>;
export type OpsAlertGroupDetail = OpsAlertDetail["group"];
export type OpsSilences = Awaited<ReturnType<typeof fetchOpsSilences>>;
export type OpsOncallView = Awaited<ReturnType<typeof fetchOpsOncall>>;
export type OpsIncidentsList = Awaited<ReturnType<typeof fetchOpsIncidents>>;
export type OpsIncidentSummary = OpsIncidentsList["incidents"][number];
export type OpsIncidentDetail = Awaited<ReturnType<typeof fetchOpsIncidentDetail>>["incident"];
export type OpsRunning = Awaited<ReturnType<typeof fetchOpsRunning>>;
export type OpsComponent = OpsRunning["components"][number];
export type OpsJobs = Awaited<ReturnType<typeof fetchOpsJobs>>;
export type OpsJob = OpsJobs["jobs"][number];
export type OpsChangesView = Awaited<ReturnType<typeof fetchOpsChanges>>;
export type OpsPromoteView = Awaited<ReturnType<typeof fetchOpsPromote>>;
export type OpsActionsList = Awaited<ReturnType<typeof fetchOpsActions>>;
export type OpsActionRecord = OpsActionsList["actions"][number];
export type OpsCmdHandOff = Awaited<ReturnType<typeof postOpsJobRerun>>["action"];
export type OpsRunbookListView = Awaited<ReturnType<typeof fetchOpsRunbooks>>;
export type OpsRunbookDocView = Awaited<ReturnType<typeof fetchOpsRunbookDoc>>;
export type OpsObligationsList = Awaited<ReturnType<typeof fetchOpsObligations>>;
export type OpsObligationItem = OpsObligationsList["items"][number];
export type OpsObligationDetail = Awaited<ReturnType<typeof fetchOpsObligationDetail>>;
export type OpsRecoveryView = Awaited<ReturnType<typeof fetchOpsRecovery>>;
export type OpsSources = Awaited<ReturnType<typeof fetchOpsSources>>;
export type OpsSource = OpsSources["sources"][number];
export type OpsEvent = S["Event"];

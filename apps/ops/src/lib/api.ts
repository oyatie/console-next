// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import type { components, paths } from "@console/api/ops-schema";

export type OpsErrorPayload = components["schemas"]["Error"];
export type OpsHealth = components["schemas"]["Health"];
export type OpsDrift = components["schemas"]["Drift"];
export type OpsEvidenceState = components["schemas"]["EvidenceState"];
export type OpsAlertState = components["schemas"]["AlertState"];
export type OpsSeverity = components["schemas"]["Severity"];
export type OpsJobState = components["schemas"]["JobState"];
export type OpsLive = components["schemas"]["Live"];

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

function normalizeError(status: number, error: unknown, response?: Response): OpsApiError {
  if (error && typeof error === "object") {
    const rec = error as Record<string, unknown>;
    if (typeof rec.code === "string" && typeof rec.message === "string") {
      return new OpsApiError(status, {
        code: rec.code,
        message: rec.message,
        support_ref: typeof rec.support_ref === "string" ? rec.support_ref : "unavailable",
        evaluated_at: typeof rec.evaluated_at === "string" ? rec.evaluated_at : new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      });
    }
  }
  const ref = response?.headers.get("x-request-id") ?? "unavailable";
  return new OpsApiError(status, {
    code: status === 503 ? "OPS_TIMEOUT" : `HTTP_${status || 503}`,
    message: status === 401 ? "Cloudflare Access session required." : status === 403 ? "Access refused by ops policy." : "Ops cockpit backend unreachable.",
    support_ref: ref,
    evaluated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
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
      evaluated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  }
}

export const opsQueryKeys = {
  me: ["ops", "me"] as const,
  home: ["ops", "home"] as const,
  alerts: (q: { state?: OpsAlertState; severity?: OpsSeverity; component?: string }) => ["ops", "alerts", q] as const,
  alertDetail: (key: string) => ["ops", "alert", key] as const,
  silences: ["ops", "silences"] as const,
  running: (q: { group?: string; state?: OpsHealth }) => ["ops", "running", q] as const,
  jobs: ["ops", "running", "jobs"] as const,
  sources: ["ops", "sources"] as const,
};

export const fetchOpsMe = () => unwrap(client.GET("/api/ops/v1/me"));
export const fetchOpsHome = () => unwrap(client.GET("/api/ops/v1/home"));
export const fetchOpsAlerts = (query: { state?: OpsAlertState; severity?: OpsSeverity; component?: string }) =>
  unwrap(client.GET("/api/ops/v1/alerts", { params: { query } }));
export const fetchOpsAlertDetail = (key: string) =>
  unwrap(client.GET("/api/ops/v1/alerts/{key}", { params: { path: { key } } }));
export const fetchOpsSilences = () => unwrap(client.GET("/api/ops/v1/silences"));
export const fetchOpsRunning = (query: { group?: string; state?: OpsHealth }) =>
  unwrap(client.GET("/api/ops/v1/running", { params: { query } }));
export const fetchOpsJobs = () => unwrap(client.GET("/api/ops/v1/running/jobs"));
export const fetchOpsSources = () => unwrap(client.GET("/api/ops/v1/sources"));

export type OpsMe = Awaited<ReturnType<typeof fetchOpsMe>>;
export type OpsHomeSnapshot = Awaited<ReturnType<typeof fetchOpsHome>>;
export type OpsAlertGroups = Awaited<ReturnType<typeof fetchOpsAlerts>>;
export type OpsAlertGroup = OpsAlertGroups["groups"][number];
export type OpsAlertDetail = Awaited<ReturnType<typeof fetchOpsAlertDetail>>;
export type OpsAlertGroupDetail = OpsAlertDetail["group"];
export type OpsSilences = Awaited<ReturnType<typeof fetchOpsSilences>>;
export type OpsRunning = Awaited<ReturnType<typeof fetchOpsRunning>>;
export type OpsComponent = OpsRunning["components"][number];
export type OpsJobs = Awaited<ReturnType<typeof fetchOpsJobs>>;
export type OpsJob = OpsJobs["jobs"][number];
export type OpsSources = Awaited<ReturnType<typeof fetchOpsSources>>;
export type OpsSource = OpsSources["sources"][number];

export type OpsEvent =
  | { type: "home.changed"; id: number; evaluated_at: string; home: OpsHomeSnapshot }
  | { type: "alert.group.changed"; id: number; evaluated_at: string; group: OpsAlertGroupDetail }
  | { type: "alert.group.resolved"; id: number; evaluated_at: string; group: OpsAlertGroupDetail }
  | { type: "component.changed"; id: number; evaluated_at: string; component: OpsComponent }
  | { type: "job.changed"; id: number; evaluated_at: string; job: OpsJob }
  | { type: "source.changed"; id: number; evaluated_at: string; source: OpsSource }
  | { type: "heartbeat"; id: number; evaluated_at: string }
  | { type: "resync"; id: number; evaluated_at: string };

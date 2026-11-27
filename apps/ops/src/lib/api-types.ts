// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/ops-schema";

type S = components["schemas"];

export type GateSubject = {
  name?: string | null;
  digest: Record<string, string>;
};

export type GateResultEntry = {
  name: string;
  result: string;
  note?: string | null;
  at?: string | null;
};

export type GateRunner = {
  kind: string;
  url?: string | null;
};

export type GateStatement = {
  _type: string;
  predicateType: string;
  subject: GateSubject[];
  predicate: {
    inputs: Record<string, unknown>;
    gates: GateResultEntry[];
    runner: GateRunner;
    approver?: unknown;
    bake: "normal" | "long" | string;
    trunk_admission?: unknown;
  };
};

export type OncallConfig = {
  version: number;
  mode: "single-operator" | "primary-backup";
  display_status: string;
  timezone: string;
  rotation: {
    primary_person: string | null;
    backup_person: string | null;
    handoff_weekday: string;
    handoff_hour_local: number;
  };
  escalation: {
    ack_timeout_s: number;
    repeat_interval_s: number;
    out_of_hours_policy: string;
    daily_page_budget: number;
  };
  synthetic_page_test: {
    enabled: boolean;
    schedule: string;
    weekday: string;
    hour_utc: number;
    max_delivery_lag_s: number;
  };
};

export type StatusPublicText = {
  ko: string;
  en?: string | null;
};

export type StatusIncidentUpdate = {
  n: number;
  at: string;
  text: StatusPublicText;
  stage: string;
  components: Record<string, string>;
  next_update_by: string | null;
  correction_of: number | null;
};

export type StatusIncident = {
  id: string;
  title: StatusPublicText;
  started_at: string;
  report_url: string | null;
  updates: StatusIncidentUpdate[];
  retroactive?: boolean | null;
  detected_at?: string | null;
  report_due?: string | null;
};

export type ObligationEventPayload =
  | { event: "in_review"; fields: { note?: string | null } }
  | { event: "redated"; fields: { due: string; reason: string } }
  | {
      event: "done";
      fields: {
        evidence_ref: string;
        signer: string;
        co_signer?: string | null;
        counsel_url?: string | null;
        signed_on: string;
      };
    }
  | {
      event: "waived";
      fields: {
        reason: string;
        signer: string;
        co_signer?: string | null;
        counsel_url?: string | null;
      };
    };

export type ObligationRecordFields = {
  kind?: S["ObligationKind"];
  reviewer_role?: S["ObligationReviewerRole"];
  title?: string;
  due?: string | null;
  evidence_ref?: string | null;
  note?: string | null;
  reason?: string | null;
  signer?: string | null;
  co_signer?: string | null;
  counsel_url?: string | null;
  signed_on?: string | null;
};

export type IncidentEventPayload =
  | { expected_seq: number; event: "lead_assigned"; fields: { lead: string } }
  | { expected_seq: number; event: "note_added"; fields: { note: string } }
  | { expected_seq: number; event: "severity_changed"; fields: { sev: S["IncidentSeverity"]; reason?: string | null } }
  | { expected_seq: number; event: "status_changed"; fields: { status: S["Incident"]; next_public_update_at?: string | null; reason?: string | null } }
  | { expected_seq: number; event: "postmortem_linked"; fields: { postmortem_ref: string } }
  | { expected_seq: number; event: "public_attached"; fields: { public_incident_id: string } }
  | { expected_seq: number; event: "mitigation_added"; fields: { action_id: string; summary: string } }
  | { expected_seq: number; event: "notice_sent"; fields: { channel: string; summary?: string | null; next_public_update_at?: string | null } }
  | { expected_seq: number; event: "resolved"; fields: { summary?: string | null } };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalNullableString(v: unknown): v is string | null | undefined {
  return v === undefined || v === null || typeof v === "string";
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isStatusPublicText(v: unknown): v is StatusPublicText {
  return isRecord(v) && typeof v.ko === "string" && isOptionalNullableString(v.en);
}

function readStringField(rec: Record<string, unknown>, key: string): string | null | undefined {
  const val = rec[key];
  if (typeof val === "string") return val;
  if (val === null) return null;
  return undefined;
}

export function readGateStatement(raw: unknown): GateStatement | null {
  if (!isRecord(raw) || typeof raw["_type"] !== "string" || typeof raw.predicateType !== "string") return null;
  if (!Array.isArray(raw.subject)) return null;
  for (const subj of raw.subject) {
    if (!isRecord(subj) || !isOptionalNullableString(subj.name) || !isRecord(subj.digest)) return null;
  }
  const pred = raw.predicate;
  if (!isRecord(pred) || !isRecord(pred.inputs) || typeof pred.bake !== "string") return null;
  if (!isRecord(pred.runner) || typeof pred.runner.kind !== "string" || !isOptionalNullableString(pred.runner.url)) {
    return null;
  }
  if (!Array.isArray(pred.gates)) return null;
  for (const g of pred.gates) {
    if (
      !isRecord(g) ||
      typeof g.name !== "string" ||
      typeof g.result !== "string" ||
      !isOptionalNullableString(g.note) ||
      !isOptionalNullableString(g.at)
    ) {
      return null;
    }
  }
  return raw as unknown as GateStatement;
}

export function readOncallConfig(raw: unknown): OncallConfig | null {
  if (!isRecord(raw) || !isFiniteNum(raw.version)) return null;
  if (raw.mode !== "single-operator" && raw.mode !== "primary-backup") return null;
  if (typeof raw.display_status !== "string" || typeof raw.timezone !== "string") return null;
  const rot = raw.rotation;
  const esc = raw.escalation;
  const syn = raw.synthetic_page_test;
  if (
    !isRecord(rot) ||
    !isOptionalNullableString(rot.primary_person) ||
    !isOptionalNullableString(rot.backup_person) ||
    typeof rot.handoff_weekday !== "string" ||
    !isFiniteNum(rot.handoff_hour_local)
  ) {
    return null;
  }
  if (
    !isRecord(esc) ||
    !isFiniteNum(esc.ack_timeout_s) ||
    !isFiniteNum(esc.repeat_interval_s) ||
    typeof esc.out_of_hours_policy !== "string" ||
    !isFiniteNum(esc.daily_page_budget)
  ) {
    return null;
  }
  if (
    !isRecord(syn) ||
    typeof syn.enabled !== "boolean" ||
    typeof syn.schedule !== "string" ||
    typeof syn.weekday !== "string" ||
    !isFiniteNum(syn.hour_utc) ||
    !isFiniteNum(syn.max_delivery_lag_s)
  ) {
    return null;
  }
  return raw as unknown as OncallConfig;
}

export function readStatusIncident(raw: unknown): StatusIncident | null {
  if (
    !isRecord(raw) ||
    typeof raw.id !== "string" ||
    !isStatusPublicText(raw.title) ||
    typeof raw.started_at !== "string" ||
    !isOptionalNullableString(raw.report_url) ||
    !Array.isArray(raw.updates)
  ) {
    return null;
  }
  for (const u of raw.updates) {
    if (
      !isRecord(u) ||
      !isFiniteNum(u.n) ||
      typeof u.at !== "string" ||
      !isStatusPublicText(u.text) ||
      typeof u.stage !== "string" ||
      (u.components !== undefined && !isRecord(u.components)) ||
      !isOptionalNullableString(u.next_update_by) ||
      (u.correction_of !== undefined && u.correction_of !== null && !isFiniteNum(u.correction_of))
    ) {
      return null;
    }
  }
  return raw as unknown as StatusIncident;
}

export function readObligationFields(raw: unknown): ObligationRecordFields {
  if (!isRecord(raw)) return {};
  return {
    title: readStringField(raw, "title") ?? undefined,
    due: readStringField(raw, "due"),
    evidence_ref: readStringField(raw, "evidence_ref"),
    note: readStringField(raw, "note"),
    reason: readStringField(raw, "reason"),
    signer: readStringField(raw, "signer"),
    co_signer: readStringField(raw, "co_signer"),
    counsel_url: readStringField(raw, "counsel_url"),
    signed_on: readStringField(raw, "signed_on"),
  };
}

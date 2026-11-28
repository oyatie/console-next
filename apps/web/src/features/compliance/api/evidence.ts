// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, unwrap } from "@console/api";
import { t } from "@console/i18n";
import { get } from "../../../lib/query";
import type { components } from "@console/api/schema";
import { PAGE_SIZE } from "../api";

type Schema = components["schemas"];

export const evidencePath = "/api/v1/compliance/evidence-bindings";
export const evidenceStates = ["PROPOSED", "ACCEPTED", "REJECTED", "EXPIRED", "RETRACTED"] as const;
export const confidences = ["LOW", "MEDIUM", "HIGH", "SYSTEM"] as const;
export const targetTypes = ["audit_event", "evidence_media", "workflow_run", "workflow_task", "object_link",
  "governance_finding", "external_document", "future_ev_object"] as const;
export const evLabel = (code: Schema["EvidenceBindingStatus"] | Schema["EvidenceConfidence"] | Schema["EvidenceTargetType"]) => t(`compliance.ev.${code}`);

export const evidenceQuery = (page: number, status?: Schema["EvidenceBindingStatus"], target?: Schema["EvidenceTargetType"]) =>
  get(evidencePath, { params: { query: { limit: PAGE_SIZE, offset: page * PAGE_SIZE, status, target_type: target } } });

type EvidenceIntent = { propose: Schema["CreateEvidenceBindingRequest"] } | { accept: string };

export async function applyEvidence(intent: EvidenceIntent, key: string) {
  const header = { "Idempotency-Key": key };
  try {
    if ("propose" in intent) return await unwrap(api.POST(evidencePath, { params: { header }, body: intent.propose }));
    return await unwrap(api.POST("/api/v1/compliance/evidence-bindings/{id}/accept", { params: { path: { id: intent.accept }, header } }));
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409 && error.code === "command_applied")) throw error;
    return null;
  }
}

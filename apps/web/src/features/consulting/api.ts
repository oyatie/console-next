// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap, type components } from "@console/api";
import { get } from "../../lib/query";

type Schema = components["schemas"];
import type { Change } from "./domain/workflow";
export type { Engagement, Change } from "./domain/workflow";
export const engagements = "/api/v1/consulting/engagements";
export const choices = "/api/v1/consulting/options";
export type OptionKind = "CUSTOMER" | "DOCUMENT" | "ONTOLOGY_INSTANCE" | "KPI_DEFINITION" | "EVIDENCE" | "APPROVAL";
const record = "/api/v1/consulting/engagements/{engagement_id}";
const history = "/api/v1/consulting/engagements/{engagement_id}/history";
export const listQuery = (q: string, offset: number) => get(engagements, { params: { query: { q, offset, limit: 25 } } });
const path = (id: string) => ({ engagement_id: id });
export const recordQuery = (id: string) => get(record, { params: { path: path(id) } });
export const historyQuery = (id: string) => get(history, { params: { path: path(id) } });
export const optionsQuery = (kind: OptionKind, q: string, offset: number, engagementId?: string) => get(choices, { params: { query: { kind, q, offset, engagementId } } });
export const createEngagement = (draft: Omit<Schema["ConsultingEngagementCreateRequest"], "idempotencyKey">, key: string) =>
  unwrap(api.POST(engagements, { body: { ...draft, idempotencyKey: key }, headers: { "Idempotency-Key": key } }));
export async function saveChange(id: string, change: Change, key: string) {
  const init = { params: { path: path(id) }, headers: { "Idempotency-Key": key } };
  switch (change.kind) {
    case "diagnostic": await unwrap(api.POST("/api/v1/consulting/engagements/{engagement_id}/diagnostics", { ...init, body: change.body })); break;
    case "finding": await unwrap(api.POST("/api/v1/consulting/engagements/{engagement_id}/findings", { ...init, body: change.body })); break;
    case "initiative": await unwrap(api.POST("/api/v1/consulting/engagements/{engagement_id}/initiatives", { ...init, body: change.body })); break;
    case "observation": await unwrap(api.POST("/api/v1/consulting/engagements/{engagement_id}/observations", { ...init, body: change.body })); break;
    case "transition": await unwrap(api.POST("/api/v1/consulting/engagements/{engagement_id}/transition", { ...init, body: change.body })); break;
  }
}

import { api, unwrap } from "@console/api";
export { ApiError } from "@console/api";
import type { FilingTask, RecordFiling, RegisterPage } from "@console/api/pending";
import { get, queryPath } from "../../lib/query";
import { LIFECYCLE_CASE_READS } from "../lifecycle/api";
export type { FilingTask, RegisterPage, FilingFacts, FilingReason, FilingCitation } from "@console/api/pending";
export const FILINGS = "/api/v1/statutory/insurance-filings";
export const FILING_READS = [queryPath(get(FILINGS)), ...LIFECYCLE_CASE_READS];
export const REGISTER = "/api/v1/statutory/worker-register";
export const workplacesQuery = (as_of: string) => get("/api/v1/statutory/workplaces", {params: {query: {as_of}}});
export const filingsQuery = (q: {workplace_id?: string; search?: string; state?: string; after?: string; event_id?: string; filing_id?: string; kind?: string; insurer?: string}) => get(FILINGS, {params: {query: q}});
export const registerQuery = (workplace_id: string, as_of: string, after?: string) => get(REGISTER, {params: {query: {workplace_id, as_of, after}}});
export const recordFiling = (task: FilingTask, body: RecordFiling, key: string) => unwrap(api.POST("/api/v1/statutory/insurance-filings/{event_id}/{kind}/{insurer}", {
  params: {path: {event_id: task.event_id, kind: task.kind, insurer: task.insurer}, header: {"Idempotency-Key": key}}, body,
}));
export const exportRegister = (workplace_id: string, as_of: string, format: "xlsx" | "pdf", export_purpose: string) => unwrap(api.GET("/api/v1/statutory/worker-register/export", {
  params: {query: {workplace_id, as_of, format, export_purpose}}, parseAs: format === "xlsx" ? "blob" : "json",
})) as Promise<Blob | RegisterPage>;

export const requestFiling = (source_event_id: string, filing_kind: string, anchor_on: string, key: string) => unwrap(api.POST(FILINGS, {
  params: {header: {"Idempotency-Key": key}}, body: {source_event_id, filing_kind, anchor_on},
}));

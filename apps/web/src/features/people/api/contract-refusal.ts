import { ApiError } from "@console/api";
import { CONTRACT_KINDS } from "../domain/facts";

/** Structured conflict metadata survives localization of the server's message. */
export function contractOverlap(error: unknown) {
  if (!(error instanceof ApiError) || error.code !== "contract_overlap") return null;
  const row = error.refusals?.[0] as Record<string, unknown> | undefined;
  if (!row || typeof row.contract_id !== "string" || typeof row.start_date !== "string" || !CONTRACT_KINDS.some((k) => k === row.kind)) return null;
  return { id: row.contract_id, start: row.start_date, end: typeof row.end_date === "string" ? row.end_date : null, kind: String(row.kind) };
}

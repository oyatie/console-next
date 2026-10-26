import { assertBoundPasskeyHash, sha256Hex, api, ApiError, unwrap } from "@console/api";
import type { components, paths } from "@console/api/schema";
import { get } from "../../../lib/query";
import { employeeRecord, pinned } from "../../../lib/record-versions";
import { correctEmployee } from "../api";

const onEmployee = (id: string) => ({ path: { id } });

// --- The personnel card (EMP-UI): personal extras (MR-34), register facts (MR-23), Form No.16 sections (MR-31/33/35), void ---

export type PersonalFacts = components["schemas"]["EmployeePersonalFacts"];
export type RegisterFacts = components["schemas"]["EmployeeRegisterFacts"];
export type RecordEntry = components["schemas"]["PersonRecordEntry"];
export type RecordList = components["schemas"]["PersonRecordList"];
export type Segment = components["schemas"]["PersonRecordSectionSegment"];
export type EmploymentFacts = paths["/api/v1/employees/{id}/employment-facts"]["get"]["responses"]["200"]["content"]["application/json"];

export const personalFactsQuery = (id: string) => get("/api/v1/employees/{id}/personal-facts", { params: onEmployee(id) });
/** Every open section's entries (the restricted ones are left out by the server unless asked with a purpose). */
export const recordsQuery = (id: string) => get("/api/v1/employees/{id}/records", { params: { path: { id }, query: { include_voided: true } } });
/** A restricted section (discipline, disability, veteran), read with a purpose the server logs. */
export const restrictedQuery = (id: string, section: "discipline" | "disability" | "veteran", purpose: string) =>
  get("/api/v1/employees/{id}/records", { params: { path: { id }, query: { section, purpose } } });
/** The people of one unit, the list the record's "n / m" and J/K walk. */
export const unitListQuery = (unitId: string) => get("/api/v1/employees", { params: { query: { org_unit_id: unitId, status: ["ACTIVE", "ON_LEAVE", "PRE_HIRE"], limit: 200 } } });

type Fields = components["schemas"]["PersonRecordFields"];
/** A new entry in a section (version 1). */
export const addRecord = (id: string, section: Segment, fields: Fields, key: string) =>
  unwrap(api.POST("/api/v1/employees/{id}/records/{section}", { params: { path: { id, section }, header: { "Idempotency-Key": key } }, body: { fields } }));
/** Corrects an entry: its next version, with why (the previous versions stay in its history). */
export const correctRecord = (id: string, section: Segment, entry: RecordEntry, fields: Fields, reason: string, key: string) =>
  unwrap(
    api.PUT("/api/v1/employees/{id}/records/{section}/{entry_id}", {
      params: { path: { id, section, entry_id: entry.id }, header: { "Idempotency-Key": key } },
      body: { expected_version: entry.version, fields, reason },
    }),
  );
/** Every version of one entry, oldest first (create, corrections, void). */
export const recordHistoryQuery = (id: string, section: Segment, entryId: string) =>
  get("/api/v1/employees/{id}/records/{section}/{entry_id}/history", { params: { path: { id, section, entry_id: entryId } } });
/** Voids an entry: struck in place, its history kept. */
export const voidRecord = (id: string, section: Segment, entry: RecordEntry, reason: string, key: string) =>
  unwrap(
    api.POST("/api/v1/employees/{id}/records/{section}/{entry_id}/void", {
      params: { path: { id, section, entry_id: entry.id }, header: { "Idempotency-Key": key } },
      body: { expected_version: entry.version, reason },
    }),
  );

/** The register facts of one person (sex, address, note). */
export const registerFactsQuery = (id: string) => get("/api/v1/employees/{id}/register-facts", { params: onEmployee(id) });

/** The voided registrations (E9 "voided registrations"). */
export const voidedQuery = get("/api/v1/employees/voided");
/** The server's error code of a failed command, if it answered with one. */
export const errorCode = (e: unknown) => (e instanceof ApiError ? e.code : undefined);
/** The resident registration number as stored: masked, or that none is (decision #25; each read is logged). */
export const rrnStatusQuery = (id: string) => get("/api/v1/employees/{id}/rrn", { params: { path: { id } } });
/** The whole number for a recorded reason (decisions #25); the server logs the reason, never the number. */
const revealProof = async (id: string, field: RevealField, reason: string) => assertBoundPasskeyHash("PII_REVEAL", id, await sha256Hex(`${field}:${reason.trim()}`));
export const revealRrn = async (id: string, reason_code: string, note?: string) => {
  const step_up = await revealProof(id, "RRN", reason_code);
  return unwrap(api.POST("/api/v1/employees/{id}/rrn/reveal", { params: { path: { id } }, body: { reason_code, ...(note ? { note } : {}), step_up } }));
};
export type RevealField = components["schemas"]["EmployeeFieldRevealRequest"]["field"];
export const revealField = async (id: string, field: RevealField, reason_code: string, note?: string) => {
  const step_up = await revealProof(id, field, reason_code);
  return unwrap(api.POST("/api/v1/employees/{id}/reveal", { params: { path: { id } }, body: { field, reason_code, ...(note ? { note } : {}), step_up } }));
};
/** Who an employee number finds: its holder, else the person whose earlier number it was (an alias). */
export const numberMatchQuery = (number: string) => get("/api/v1/employees/by-number/{number}", { params: { path: { number } } });
/**
 * A dated employee-number change (decision #25): the old number stays the person's alias. Its answer names no employee
 * version, so the chain of this tab's own writes ends here until the card re-reads (unit me6-employee-field-preconditions).
 */
export const changeEmployeeNumber = (id: string, body: components["schemas"]["EmployeeNumberChangeRequest"]) =>
  pinned(employeeRecord(id), body.expected_updated_at, ["employee_number"], (at) =>
    unwrap(api.POST("/api/v1/employees/{id}/employee-number", { params: { path: { id } }, body: { ...body, expected_updated_at: at } })));
/** One workplace's people by status (the register's counts). */
export const workplaceCountsQuery = (workplaceId?: string, status?: ("ACTIVE" | "ON_LEAVE" | "EXITED")[]) =>
  get("/api/v1/employees/facets", { params: { query: { ...(workplaceId && { workplace_id: workplaceId }), ...(status && { status }) } } });
/** The first lines of one workplace's register, for its preview (the file itself is the server's). */
export const registerPreviewQuery = (workplaceId: string) => get("/api/v1/employees", { params: { query: { workplace_id: workplaceId, status: ["ACTIVE", "ON_LEAVE"], limit: 10 } } });

type PhotoType = components["schemas"]["EmployeePhotoUpload"]["content_type"];
/**
 * Uploads one photo the way the server asks (MR-34): a presigned PUT it signs for this type and size, then confirm (it checks
 * the stored object), then PATCH the employee's `photo` to the confirmed upload. Each step's refusal is the server's own;
 * a refused PUT (the store's own answer) says `putFailed(status)`.
 */
export async function uploadPhoto(id: string, updatedAt: string, file: File, putFailed: (status: number) => string) {
  const issued = await unwrap(api.POST("/api/v1/employees/{id}/photo-uploads", { params: { path: { id } }, body: { content_type: file.type as PhotoType, byte_size: file.size } }));
  const put = await fetch(issued.put.url, { method: issued.put.method, headers: issued.put.headers.map(([k, v]) => [k ?? "", v ?? ""] as [string, string]), body: file });
  if (!put.ok) throw new Error(putFailed(put.status));
  await unwrap(api.POST("/api/v1/employees/{id}/photo-uploads/{upload_id}/confirm", { params: { path: { id, upload_id: issued.upload_id } } }));
  return correctEmployee(id, updatedAt, { photo: issued.upload_id }, "QUICK_EDIT");
}

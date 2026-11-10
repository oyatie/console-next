// The evidence a write records: what it was taken from, and a named supervisor for a supervisor's confirmation.
import { ATTENDANCE_EVIDENCE } from "../../../lib/labels";

/** AttendanceEvidence.note maxLength in the OpenAPI contract. */
export const NOTE_MAX_LENGTH = 500;
export const EVIDENCE = ATTENDANCE_EVIDENCE.values;
type Kind = (typeof EVIDENCE)[number];
/** The wire shape (AttendanceEvidence). */
type Evidence = { kind: Kind; note?: string; confirmer_employee_id?: string };
export type EvidenceDraft = { kind: Kind | null; note: string; confirmer: { id: string; name: string } | null };
export const EMPTY_EVIDENCE: EvidenceDraft = { kind: null, note: "", confirmer: null };

/** The evidence a write records (G7: nothing chosen at first), or null while incomplete (a supervisor confirmation names who confirmed). */
export const evidenceOf = (e: EvidenceDraft): Evidence | null =>
  !e.kind || (e.kind === "SUPERVISOR_CONFIRM" && !e.confirmer) || (e.kind === "OTHER" && !e.note.trim())
    ? null
    : { kind: e.kind, note: e.note.trim() || undefined, confirmer_employee_id: e.confirmer?.id };

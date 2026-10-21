// Reading a recorded revision (pure): which kind of entry it is and the Korean day it was recorded on.
import type { Revision } from "@console/api/pending";
import { todayKst } from "../../../lib/pure/today";

/**
 * What a revision was, for its line in the history: the first record, a correction, a change the user asked for, or
 * the VAT filing unit — set by the certificates (derived, nobody's change) or chosen while adding a workplace.
 */
export type RevisionKind = "created" | "corrected" | "changed" | "derived" | "declared";
export const revisionKind = (r: Pick<Revision, "version" | "reason_code">): RevisionKind =>
  r.version === 1 ? "created"
  : r.reason_code === "CORRECTION" ? "corrected"
  : r.reason_code === "VAT_UNIT_DERIVED" ? "derived"
  : r.reason_code === "VAT_UNIT_DECLARED" ? "declared"
  : "changed";

/** The day (YYYY-MM-DD) a recorded instant falls on in Korea: 2026-10-06T20:00Z is 10-07 there, not 10-06. */
export const recordedDay = (instant: string) => todayKst(new Date(instant));

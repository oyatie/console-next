// Values the record's editors hold (pure): the representatives as they will stand, and addresses as the editor
// holds them. Their text is in present.ts.
import type { KrAddress, RepresentationMode } from "@console/api/pending";
import { addressChange, storedDistrict } from "./capture";
import type { AddrDraft } from "./draft";

/** The representatives as they will stand: who stays, who leaves on the date, who is appointed, and how they represent. */
export type Reps = { names: string[]; leaving: boolean[]; added: string[]; mode: RepresentationMode | null };
export const repsAfter = (r: Reps) => [...r.names.filter((_, i) => !r.leaving[i]), ...r.added.map((n) => n.trim()).filter(Boolean)];
/** More than one representative: how they represent is asked again, never carried over silently. */
export const repsReady = (r: Reps, before: string[], beforeMode: RepresentationMode | null | undefined) => {
  const after = repsAfter(r);
  if (after.length === 0) return false;
  // More than one: a mode of several is required; the single one carried from one representative does not count.
  const mode = after.length > 1 ? (r.mode === "SINGLE" ? null : r.mode) : "SINGLE";
  if (!mode) return false;
  return after.join("|") !== before.join("|") || mode !== (beforeMode ?? "SINGLE");
};
/** How several representatives represent, once asked (null for one, or before it is asked). */
export const repsMode = (r: Reps) => (repsAfter(r).length > 1 && r.mode !== "SINGLE" ? r.mode : null);

export type Addr = AddrDraft;
/** An address as the address editor holds it. */
export const toAddr = (a: KrAddress | null | undefined): Addr | null =>
  a ? { key: a.bd_mgt_sn ?? undefined, road: a.road_addr_part1, zip: a.zip_no ?? "", detail: a.detail ?? "", verified: a.source === "JUSO", district: storedDistrict(a) } : null;
/** Back to the structured address: the same place with a new detail keeps its codes; a new place is sent anew. */
export const toKr = (v: Addr | null, old: KrAddress | null | undefined): KrAddress | null => (!v ? null : (addressChange(old, v) ?? old ?? null));

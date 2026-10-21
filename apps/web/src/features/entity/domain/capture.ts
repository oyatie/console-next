// Coded picks and addresses as stored (design §4, §5). Pure.
import type { CodeRef, KrAddress } from "@console/api/pending";
import type { AddrDraft } from "./draft";
import { krAddress } from "./plan";

/** A pick from a loaded list as stored: code, label and the list version, so a later list never rewrites it. */
export const codeRef = (code: string, label: string, version: string | undefined): CodeRef => ({ code, label, version: version ?? "" });

/** The district a stored address already carries, so the picker shows it (its label is the stored names). */
export const storedDistrict = (a: KrAddress): CodeRef | null =>
  a.adm_cd ? { code: a.adm_cd, label: [a.si_nm, a.sgg_nm, a.emd_nm].filter(Boolean).join(" "), version: "" } : null;

/**
 * The new address to send, or undefined when nothing changed. Kept on the same road with only a new unit, the stored
 * address keeps its codes and changes its detail; a new road or a newly picked district replaces it.
 */
export function addressChange(old: KrAddress | null | undefined, next: AddrDraft): KrAddress | undefined {
  const detail = next.detail.trim() || null;
  const sameRoad = old != null && next.road === old.road_addr_part1;
  const sameDistrict = (next.district?.code ?? null) === (old?.adm_cd ?? null) || next.verified;
  if (sameRoad && sameDistrict) return detail === (old.detail ?? null) ? undefined : { ...old, detail };
  return { ...krAddress(next), as_printed: old?.as_printed ?? null };
}

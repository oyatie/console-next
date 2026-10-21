// A Korean address as the address field holds it, and as the server stores it. Shared by every slice that asks
// for a workplace's address. Pure.
// the same helpers live in features/entity (domain/draft.ts AddrDraft, domain/plan.ts krAddress); that
// slice should import these once its lane is free to change, and drop its copy.
import type { KrAddress } from "@console/api/pending";

/**
 * An address as the address field holds it. `verified` false: typed by hand while search was down. `juso`: the
 * search result it came from, with its codes, so the server stores the structured address and not the text.
 */
export type AddrDraft = { key?: string; road: string; jibun?: string; zip: string; detail: string; verified: boolean; juso?: KrAddress };

// Ends in si (city), gun (county) or gu (district).
const DISTRICT_END = /[\uC2DC\uAD70\uAD6C]$/;
function district(road: string) {
  const [si = "", ...rest] = road.trim().split(/\s+/);
  const sgg: string[] = [];
  for (const w of rest) {
    if (sgg.length >= 2 || !DISTRICT_END.test(w)) break;
    sgg.push(w);
  }
  return { si_nm: si, sgg_nm: sgg.join(" ") || null };
}

/**
 * The structured address: the search result with its codes, or, typed by hand while search was down, the text
 * marked unverified, its province from the first word and its district from the words after it that end in si,
 * gun or gu. pick both from the administrative-district list once that list is loaded.
 */
export const krAddress = (a: AddrDraft): KrAddress => ({
  ...(a.juso ?? { source: "MANUAL_UNVERIFIED" as const, road_addr_part1: a.road, zip_no: a.zip || null, ...district(a.road) }),
  detail: a.detail.trim() || null,
  as_printed: null,
});

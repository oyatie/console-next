// A hand-typed Korean address read into the structured fields the server requires for an unverified (manual) row:
// the province is the first word, the district the next one or two words ending in si, gun or gu. Pure.

// Ends in si (city), gun (county) or gu (district).
const DISTRICT_END = /[\uC2DC\uAD70\uAD6C]$/;

/** The manual address for a typed line, or null when it names no district (the server refuses one without). */
export function manualAddress(text: string) {
  const road = text.trim().replace(/\s+/g, " ");
  const [si = "", ...rest] = road.split(" ");
  const sgg: string[] = [];
  for (const w of rest) if (sgg.length < 2 && DISTRICT_END.test(w)) sgg.push(w); else break;
  return sgg.length ? { source: "MANUAL_UNVERIFIED" as const, road_addr_part1: road, si_nm: si, sgg_nm: sgg.join(" ") } : null;
}

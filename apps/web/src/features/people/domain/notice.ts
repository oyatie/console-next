// An appointment notice's document (spec E5-notice): the lines grouped by kind of act in a fixed order, each line's
// unit and position before and its appointment read from the recorded event. Pure.
import type { components } from "@console/api/schema";

type Line = components["schemas"]["AppointmentNoticeLine"];
type Kind = Line["event"]["event_type"];
/** The order sections read in (the acts a notice carries; anything else follows in the server's order). */
const ORDER: readonly Kind[] = ["TRANSFER", "GROUP_TRANSFER", "PROMOTE", "APPOINT", "EMPLOYMENT_TYPE_CHANGE", "CONTRACT_RENEWAL", "LEAVE_OF_ABSENCE", "RETURN_FROM_LEAVE"];

export type Section = { kind: Kind; lines: Line[] };

export function sections(lines: readonly Line[]): Section[] {
  const kinds = [...new Set(lines.map((l) => l.event.event_type))].sort((a, b) => (ORDER.indexOf(a) + 1 || 99) - (ORDER.indexOf(b) + 1 || 99));
  return kinds.map((kind) => ({ kind, lines: lines.filter((l) => l.event.event_type === kind) }));
}

/** Where the person stood before the act (unit and position). */
export const before = (l: Line) => [l.event.from_org_unit, l.event.from_position].filter(Boolean).join(" · ") || "—";

/** The appointment: what the act makes them (the unit, the position, a contract's new end), in the event's own words. */
export function after(l: Line): string {
  const e = l.event;
  if (e.event_type === "CONTRACT_RENEWAL") return [e.effective_date, e.contract_end_date].filter(Boolean).join(" ~ ");
  if (e.event_type === "PROMOTE" || e.event_type === "APPOINT") return [e.to_position, e.to_job].filter(Boolean).join(" · ") || "—";
  return [e.to_org_unit, e.to_position !== e.from_position ? e.to_position : null].filter(Boolean).join(" · ") || "—";
}

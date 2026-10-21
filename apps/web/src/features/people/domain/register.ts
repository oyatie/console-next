// The registration draft (spec E3) and what it still lacks, in page order. Pure.
import { parseTyped } from "../../../ui/date/days";

/** Every employment type the server takes, in the order the chips show them. */
export const EMPLOYMENT_TYPES = ["REGULAR", "CONTRACT", "PART_TIME", "DAILY", "INTERN", "EXECUTIVE", "DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
/** Where the person goes: in a department, or directly under a workplace or unplaced. */
export type Where = "unit" | "site" | "none";

export type Draft = {
  name: string;
  /** As typed; read by parseTyped. */
  birth: string;
  numberMode: "auto" | "manual";
  number: string;
  where: Where | null;
  unitId: string;
  /** The workplace picked for a unit that is not under a registered one ("" until then). */
  workplaceId: string;
  /** `YYYY-MM-DD` or "" (DateChips keeps unparsed text itself). */
  hire: string;
  hireTyped: boolean;
  type: EmploymentType | null;
  phone: string;
  position: string;
  pay: string;
  contractEnd: string;
};

export const EMPTY: Draft = { name: "", birth: "", numberMode: "auto", number: "", where: null, unitId: "", workplaceId: "", hire: "", hireTyped: false, type: null, phone: "", position: "", pay: "", contractEnd: "" };

export type Gap = "name" | "birth" | "number" | "where" | "unit" | "workplace" | "hire" | "type" | "contractEnd" | "phone" | "position" | "pay";

/** The ISO birth date, "" when empty, null when the text is not a date. */
export const birthDate = (d: Draft): string | null => {
  const p = parseTyped(d.birth);
  return "date" in p ? p.date : "empty" in p ? "" : null;
};

/**
 * What blocks the registration, in page order: required fields left empty and typed values that are not one.
 * `phoneOk` is the phone formatter's verdict (a complete number).
 */
/** `placeHasBranch`: the chosen place resolves to a workplace with its leave-routing branch (else one is picked). */
export function gaps(d: Draft, phoneOk: boolean, placeHasBranch = true): Gap[] {
  const out: Gap[] = [];
  if (!d.name.trim()) out.push("name");
  if (birthDate(d) === null) out.push("birth");
  if (d.numberMode === "manual" && !d.number.trim()) out.push("number");
  // A place picked (or preset) answers the chips too: its kind says which.
  if (d.where && d.where !== "none" && !d.unitId) out.push("unit");
  if (d.unitId && !placeHasBranch) out.push("workplace");
  if (!d.hire) out.push("hire");
  if (d.contractEnd && (!("date" in parseTyped(d.contractEnd)) || d.contractEnd < d.hire)) out.push("contractEnd");
  if (d.phone.trim() && !phoneOk) out.push("phone");
  return out;
}

/** What a registration run can carry to the next person (spec E3-run carry chips; the person's own facts never carry). */
export const CARRY = ["place", "hire", "type", "position", "pay"] as const;
export type CarryKey = (typeof CARRY)[number];

/** After "register and add next": everything about the person goes; nothing is carried unless asked (spec E3 I). */
export const nextPerson = (d: Draft, carry: ReadonlySet<CarryKey>): Draft => ({
  ...EMPTY,
  ...(carry.has("place") && { where: d.where, unitId: d.unitId, workplaceId: d.workplaceId }),
  ...(carry.has("hire") && { hire: d.hire }),
  ...(carry.has("type") && { type: d.type, contractEnd: d.contractEnd }),
  ...(carry.has("position") && { position: d.position }),
  ...(carry.has("pay") && { pay: d.pay }),
});

/** Whether a carried field still holds the value carried into it (its carried tag); editing it drops the tag. */
export const isCarried = (d: Draft, from: Draft | null, k: CarryKey, carry: ReadonlySet<CarryKey>) =>
  from !== null && carry.has(k) && ({ place: d.unitId === from.unitId, hire: d.hire === from.hire, type: d.type === from.type, position: d.position === from.position, pay: d.pay === from.pay })[k];

/** The answer to "may be the same person": none until picked; a namesake needs its exception reason (and a note for "other"). */
export type DupPick = { verdict: "same" | "other" | "rehire" | null; code: string | null; note: string };
export const NO_PICK: DupPick = { verdict: null, code: null, note: "" };

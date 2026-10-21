// BW-18 master-data corrections: which fields a correction (or a request for one) may change, which of them a
// second person must apply, and the changes a form sends (only what differs from the record).
import { phoneE164 } from "../../../lib/pure/formats";

export const FIELDS = ["name", "phone", "hire_date", "employment_type", "base_pay"] as const;
export type Field = (typeof FIELDS)[number];
/** Fields that wait for a second person when one exists (the server decides; this only says so beforehand). */
export const SECOND_PERSON: readonly Field[] = ["hire_date", "employment_type", "base_pay"];

export type Current = Partial<Record<Field, string>>;
export type Draft = Record<Field, string>;
export const EMPTY: Draft = { name: "", phone: "", hire_date: "", employment_type: "", base_pay: "" };

/** The value as the server stores it: E.164 for a phone, whole won as digits for pay, the rest trimmed. */
const canon = (f: Field, v: string) => (f === "phone" ? (phoneE164(v) ?? v.trim()) : f === "base_pay" ? v.replace(/\D/g, "") : v.trim());

/** Only the fields typed and different from the record, each in the server's form. */
export function changes(current: Current, draft: Draft): Partial<Record<Field, string>> {
  const out: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) {
    const v = canon(f, draft[f]);
    if (v && v !== canon(f, current[f] ?? "")) out[f] = v;
  }
  return out;
}

/** Whether a correction with these changes waits for a second person (any of the dated or paid facts). */
export const needsSecond = (c: Partial<Record<Field, string>>) => SECOND_PERSON.some((f) => f in c);

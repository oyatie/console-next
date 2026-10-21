// Bulk contract decisions (spec E6-renew, BE-EMP-UI §3): each person's answer — renew on the same term, convert to an
// open-ended contract, or not renew (an exit, reported one by one) — turned into the batches the server takes: one per
// answer and contract end, since a batch has one effective date (the day after that end). Pure.
import { addDays, addMonths } from "../../../ui/date/days";

export type RenewChoice = "renew" | "convert" | "leave";
export type RenewPerson = { id: string; end: string | null };
export type RenewBatch = { choice: Exclude<RenewChoice, "leave">; effective: string; end?: string; ids: string[] };

/** A renewal of `months` from the day after `end`: it ends the day before the same date that many months on. */
export const renewedEnd = (end: string, months: number) => addDays(addMonths(addDays(end, 1), months), -1);

/**
 * The batches to send, in a stable order (renewals first, then conversions; earlier ends first). People with no
 * contract end, or no answer, are not in any batch (the page names them); `leave` is never a batch.
 */
export function renewBatches(people: readonly RenewPerson[], choices: Readonly<Record<string, RenewChoice>>, months: number): RenewBatch[] {
  const out = new Map<string, RenewBatch>();
  for (const p of people) {
    const c = choices[p.id];
    if (!p.end || !c || c === "leave") continue;
    const k = `${c}|${p.end}`;
    const b = out.get(k) ?? { choice: c, effective: addDays(p.end, 1), ...(c === "renew" ? { end: renewedEnd(p.end, months) } : {}), ids: [] };
    b.ids.push(p.id);
    out.set(k, b);
  }
  return [...out.values()].sort((a, b) => (a.choice === b.choice ? a.effective.localeCompare(b.effective) : a.choice === "renew" ? -1 : 1));
}

/** How many answered each way, and how many are still to answer. */
export const tallyChoices = (people: readonly RenewPerson[], choices: Readonly<Record<string, RenewChoice>>) => {
  const n = { renew: 0, convert: 0, leave: 0, open: 0 };
  for (const p of people) n[choices[p.id] ?? "open"]++;
  return n;
};

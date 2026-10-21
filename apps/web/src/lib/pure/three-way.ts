// Three-way merge per form field (docs/design/concurrent-editing.md §1, §3: ME-1..ME-5).
// Each field keeps base (as loaded), yours (the user's input) and current (latest from
// the server). The conflict state is derived from the triple, never stored, so it stays
// right when current moves again.

export type Field = { readonly base: unknown; readonly yours: unknown; readonly current: unknown };

/** What a new server value did to a field. */
export type Outcome =
  | "unchanged" // current did not move off base
  | "take" // ME-1: field not edited; taken silently, highlight it
  | "same" // ME-3: edited to the value the server now has; no conflict
  | "conflict"; // ME-2: edited, and the server has a different value; block submit

/** ME-2 choices: "theirs" uses the server value, "mine" keeps the input. */
export type Choice = "theirs" | "mine";

/** RFC 6902 §4.6 equality (ME-9): objects unordered, arrays ordered, a missing value is not null. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao);
  return keys.length === Object.keys(bo).length && keys.every((k) => Object.hasOwn(bo, k) && jsonEqual(ao[k], bo[k]));
}

export const load = (value: unknown): Field => ({ base: value, yours: value, current: value });

export const isDirty = (f: Field): boolean => !jsonEqual(f.yours, f.base);

export function outcome(f: Field): Outcome {
  if (jsonEqual(f.current, f.base)) return "unchanged";
  if (!isDirty(f)) return "take";
  return jsonEqual(f.current, f.yours) ? "same" : "conflict";
}

export const isConflict = (f: Field): boolean => outcome(f) === "conflict";

/** The user typed. */
export const edit = (f: Field, yours: unknown): Field => ({ ...f, yours });

/**
 * A new server value arrived (refetch, or a 409 `field_conflict`/`stale_facts` entry's
 * `current`). Applies ME-1 and ME-3; a conflict keeps base and yours until the user chooses.
 * The user's input is never dropped (ME-5): it changes only when it still equals base.
 */
export function rebase(f: Field, current: unknown): { field: Field; outcome: Outcome } {
  const next = { ...f, current };
  const o = outcome(next);
  if (o === "take") return { field: load(current), outcome: o };
  if (o === "same") return { field: { ...next, base: current }, outcome: o };
  return { field: next, outcome: o };
}

/** ME-2: "mine" moves base to current, so the next `test` op sends the new base. */
export function resolve(f: Field, choice: Choice): Field {
  return choice === "theirs" ? load(f.current) : { ...f, base: f.current };
}

export type Fields<K extends string = string> = Readonly<Record<K, Field>>;

/**
 * Rebase every field of a form against a server record. A key missing from `current`
 * stays as it is (a partial 409 body names only the conflicting fields). The keys whose
 * outcome is not "unchanged" are the ones to highlight and to re-validate dependents of (ME-4).
 */
export function rebaseAll<K extends string>(
  fields: Fields<K>,
  current: Partial<Readonly<Record<K, unknown>>>,
): { fields: Fields<K>; outcomes: Readonly<Record<K, Outcome>> } {
  const nextFields = { ...fields } as Record<K, Field>;
  const outcomes = {} as Record<K, Outcome>;
  for (const k of Object.keys(fields) as K[]) {
    const f = fields[k];
    if (Object.hasOwn(current, k)) {
      const r = rebase(f, current[k]);
      nextFields[k] = r.field;
      outcomes[k] = r.outcome;
    } else {
      outcomes[k] = outcome(f);
    }
  }
  return { fields: nextFields, outcomes };
}

/** Submit stays blocked until every conflict has an explicit choice (ME-2). */
export const hasConflict = (fields: Fields): boolean => Object.values(fields).some(isConflict);

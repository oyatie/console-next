// Import rules the screen follows. The server decides every outcome; these only say what is still open before the
// next step, so a disabled button always names why.
import type { Decision, ImportDecisions, ImportDryRun, ImportOutcome, ImportPreview, ImportRow } from "./contract";

/** What the user answered between the preview and apply, sent whole with every dry run so the digest covers it. */
export type Picks = Required<ImportDecisions>;
export type Exclusion = Picks["exclusions"][string];
/** A value-map decision: one answer per distinct text in the file. */
export type ValueDecision = "company_map" | "unit_map" | "workplace_map" | "employment_type_map" | "status_map" | "leave_type_map";

export const initialPicks = (): Picks => ({
  company_map: {}, unit_map: {}, workplace_map: {}, employment_type_map: {}, identity: {}, exclusions: {}, status_map: {}, leave_type_map: {}, employee_numbers: {}, group_exclusions: {},
  group_answers: {},
});

/** Columns the server read as the work site although headed workplace (G9): said on the preview, never asked. */
export const siteNoticeColumns = (p: ImportPreview) =>
  p.columns.filter((c) => (c as { notice?: string | null }).notice === "customer_site_not_workplace").map((c) => c.source_header);

/** One JSON form for comparing answers: keys sorted at every level, an empty note dropped. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).filter(([k, y]) => !(k === "note" && !y)).sort(([a], [b]) => a.localeCompare(b)))
      : x,
  );

/** The answers the last dry run used that came from the operator: those the company's memory filled in left out. */
function operatorAnswers(d: ImportDryRun): Picks {
  const out = { ...initialPicks(), ...d.decisions } as Record<string, Record<string, unknown>>;
  for (const r of d.remembered ?? []) {
    if (!(r.decision in out)) continue;
    out[r.decision] = { ...out[r.decision] };
    delete out[r.decision]![r.key];
  }
  return out as unknown as Picks;
}

/** Whether the answers on screen differ from those the last dry run used (the next dry run must carry them). */
export const picksPending = (d: ImportDryRun, c: Picks) => canon(operatorAnswers(d)) !== canon(c);

/** The keyed answer maps (every decision but the fixed-shape group answers). */
type Keyed = Exclude<keyof Picks, "group_answers">;
const set = <K extends Keyed>(c: Picks, k: K, key: string, v: Picks[K][string] | undefined): Picks => {
  const next = { ...c[k] } as Picks[K];
  if (v === undefined) delete next[key];
  else next[key] = v;
  return { ...c, [k]: next };
};

/** A text in the file → what it means (an id, a code, or null for "none of these"); undefined forgets the answer. */
export const withValue = <K extends ValueDecision>(c: Picks, k: K, text: string, v: Picks[K][string] | undefined) => set(c, k, text, v);
/** The employee number the operator gives a new person who has none (no employee number); empty forgets it. */
export const withNumber = (c: Picks, sourceKey: string, number: string) => set(c, "employee_numbers", sourceKey, number.trim() || undefined);

/** A row the server could not settle: the person it is (an id), a new person (null), or left out with a reason. One answer per row. */
export function withRowAnswer(c: Picks, sourceKey: string, a: { employeeId: string | null } | { exclude: Exclusion } | null): Picks {
  const cleared = set(set(c, "identity", sourceKey, undefined), "exclusions", sourceKey, undefined);
  if (a === null) return cleared;
  return "exclude" in a ? set(cleared, "exclusions", sourceKey, a.exclude) : set(cleared, "identity", sourceKey, { employee_id: a.employeeId });
}

/**
 * Every refused row of one kind left out at once (BE-MIG W05 group answer), with its BW-07 reason; null takes the
 * answer back. A row's own exclusion still wins over its group's.
 */
export const withGroupExclusion = (c: Picks, key: string, exclude: Exclusion | null) => set(c, "group_exclusions", key, exclude ?? undefined);

/** The conflict patterns one answer settles for every row (r3:hire-19), and the answers each takes. */
export const GROUP_ANSWERS = { workplace_conflict: ["follow_unit", "follow_workplace"], status_conflict: ["pre_hire"] } as const;
export type AnsweredPattern = keyof typeof GROUP_ANSWERS;
export const isAnsweredPattern = (reason: string): reason is AnsweredPattern => reason in GROUP_ANSWERS;
/** One answer for a conflict pattern; null takes it back. */
export function withGroupAnswer(c: Picks, pattern: AnsweredPattern, answer: string | null): Picks {
  const next = { ...c.group_answers } as Record<string, string>;
  if (answer === null) delete next[pattern];
  else next[pattern] = answer;
  return { ...c, group_answers: next as Picks["group_answers"] };
}

/** The identity choice that means "a new person" (review item choices). */
export const NEW_PERSON = "new";
/** The value-map answer that means "none of these" (unplaced, a customer site, an empty field), sent as null. */
export const NONE = "-";

/**
 * One click on a served choice: `decisions[decision][key] = choice`, typed as the decision needs it. The caller runs
 * the dry run again with the result.
 */
export function withChoice(c: Picks, decision: Exclude<Decision, "mapping" | "exclusions" | "group_exclusions">, key: string, choice: string): Picks {
  switch (decision) {
    case "identity": return withRowAnswer(c, key, { employeeId: choice === NEW_PERSON ? null : choice });
    case "employee_numbers": return withNumber(c, key, choice);
    case "company_map": case "unit_map": case "workplace_map": return withValue(c, decision, key, choice === NONE ? null : choice);
    case "employment_type_map": return withValue(c, decision, key, choice === NONE ? null : (choice as Picks["employment_type_map"][string]));
    case "status_map": return withValue(c, decision, key, choice as Picks["status_map"][string]);
    case "leave_type_map": return withValue(c, decision, key, choice as Picks["leave_type_map"][string]);
    default: throw new TypeError("Unsupported import decision");
  }
}

/** The answer on screen for a decision key, as the choice string the controls use (null: not answered here). */
export function answerOf(c: Picks, decision: Decision, key: string): string | null {
  if (decision === "mapping") return null;
  if (decision === "identity") return key in c.identity ? (c.identity[key]!.employee_id ?? NEW_PERSON) : null;
  if (decision === "exclusions") return key in c.exclusions ? "exclude" : null;
  if (decision === "group_exclusions") return key in c.group_exclusions ? "exclude" : null;
  if (!Object.hasOwn(c, decision)) return null;
  const map = c[decision as keyof Picks] as Record<string, string | null>;
  return key in map ? (map[key] ?? NONE) : null;
}

/** Rows apply refuses while they stand: refused, or a person the server could not tell. */
export const UNSETTLED: readonly ImportOutcome[] = ["refused", "unresolved_identity"];
export const needsAnswer = (r: ImportRow) => UNSETTLED.includes(r.outcome);

/** Rows left out without a reason yet, or with Other and no note: the next dry run waits for them (BW-07). */
export const reasonsMissing = (c: Picks, other: string) =>
  [...Object.values(c.exclusions), ...Object.values(c.group_exclusions)].filter((x) => !x.reason_code || (x.reason_code === other && !x.note?.trim())).length;

/** What still blocks apply: the served needs-review items that block, and answers not yet in a dry run. */
export function applyBlockers(d: ImportDryRun, c: Picks) {
  const pending = picksPending(d, c);
  return { rows: d.review.blocking, pending, any: d.review.blocking > 0 || pending };
}

export const OUTCOMES: readonly ImportOutcome[] = ["insert", "update", "unchanged", "excluded", "refused", "unresolved_identity"];

/** Rows per outcome, every outcome present (zero included) so the summary keeps its shape. */
export function tally(rows: readonly ImportRow[]) {
  const n = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<ImportOutcome, number>;
  for (const r of rows) n[r.outcome] += 1;
  return n;
}

/** Differences import never writes for a person on file; each goes to the flow that does it. */
export const deferredCount = (d: ImportDryRun) => d.rows.reduce((s, r) => s + (r.deferred?.length ?? 0), 0);

/** A row the user should look at: to settle, a deferred difference, a value that placed nobody, or no employee number yet. */
export const needsLook = (r: ImportRow) =>
  needsAnswer(r) || (r.deferred?.length ?? 0) > 0 || Boolean(r.unit_name || r.workplace_name) || (r.new_person != null && r.new_person.employee_number == null);

/** The rows the outcome filter shows. `attention` is everything to look at before apply, the rows that block first. */
export type RowFilter = "all" | "attention" | "on_leave" | ImportOutcome;
export const filterRows = (rows: readonly ImportRow[], f: RowFilter) =>
  f === "all" ? rows
  : f === "attention" ? [...rows.filter(needsAnswer), ...rows.filter((r) => !needsAnswer(r) && needsLook(r))]
  : f === "on_leave" ? rows.filter((r) => r.new_person?.status === "ON_LEAVE")
  : rows.filter((r) => r.outcome === f);

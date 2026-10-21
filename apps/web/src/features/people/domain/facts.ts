// Employment facts and contracts (EMP-MODEL): what a facts edit sends and what a contract needs. Pure rules; the
// server enforces each of them again.
import type { paths } from "@console/api/schema";

export type Facts = paths["/api/v1/employees/{id}/employment-facts"]["get"]["responses"][200]["content"]["application/json"];
export type Contract = paths["/api/v1/employees/{id}/contracts"]["get"]["responses"][200]["content"]["application/json"]["items"][number];
export type ContractKind = Contract["kind"];
export type PayUnit = Contract["pay_unit"];
export type PatchOp = { op: "test" | "replace"; path: string; value: unknown };

/** The facts an HR admin edits, by the JSON pointer the server takes. */
export const FACT_PATHS = {
  birth_date: "/birth_date",
  work_email: "/work_email",
  id_type: "/id_type",
  base_pay_won: "/employment/base_pay_won",
  pay_unit: "/employment/pay_unit",
  probation_end_date: "/employment/probation_end_date",
} as const;
export type FactKey = keyof typeof FACT_PATHS;
export type FactValues = Record<FactKey, string | number | null>;

/** The editable facts as read (null where unset or where there is no employment profile). */
export const factValues = (f: Facts): FactValues => {
  const m = f.employment ?? f.pending_employment;
  return {
  birth_date: f.birth_date,
  work_email: f.work_email,
  id_type: f.id_type,
  base_pay_won: m?.base_pay_won ?? null,
  pay_unit: m?.pay_unit ?? null,
  probation_end_date: m?.probation_end_date ?? null,
  };
};

/**
 * The patch for what changed: each write preceded by a `test` of the value it was read as, so a change made
 * meanwhile is refused (409 field_conflict) instead of overwritten. Pay and its unit are written together.
 */
export function factsPatch(base: FactValues, next: FactValues): PatchOp[] {
  const changed = new Set((Object.keys(FACT_PATHS) as FactKey[]).filter((k) => base[k] !== next[k]));
  if (changed.has("base_pay_won") || changed.has("pay_unit")) ["base_pay_won", "pay_unit"].forEach((k) => changed.add(k as FactKey));
  return [...changed].flatMap((k) => [
    { op: "test" as const, path: FACT_PATHS[k], value: base[k] },
    { op: "replace" as const, path: FACT_PATHS[k], value: next[k] },
  ]);
}

/** A plain address check (one @, a dot after it); the server validates again. */
export const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/** Labour contracts: a wage above 0 and contracted weekly hours are required terms (Labor Standards Act art. 17(1)). */
export const LABOUR: readonly ContractKind[] = ["OPEN_ENDED", "FIXED_TERM", "PART_TIME", "DAILY"];
export const CONTRACT_KINDS: readonly ContractKind[] = [...LABOUR, "DISPATCH_OUTSOURCING", "EXECUTIVE_MANDATE", "FREELANCE_SERVICE"];
export const PAY_UNITS: readonly PayUnit[] = ["MONTHLY", "HOURLY", "DAILY", "ANNUAL"];

/** A contract as typed: dates `YYYY-MM-DD` or "", wage digits, weekly hours as typed (e.g. "40", "37.5"). */
export type ContractDraft = { kind: ContractKind | null; start: string; end: string; wage: string; unit: PayUnit | null; hours: string };
export type ContractIssue = "required" | "endBeforeStart" | "wagePositive" | "hoursRange";

/** Weekly hours as minutes, or null when not a number of hours in a week (0 < h ≤ 168). */
export const weeklyMinutes = (hours: string): number | null => {
  const h = Number(hours);
  return hours.trim() !== "" && Number.isFinite(h) && h > 0 && h <= 168 ? Math.round(h * 60) : null;
};

/** What stops a contract from being recorded, per field; an empty object records. */
export function contractIssues(d: ContractDraft): Partial<Record<keyof ContractDraft, ContractIssue>> {
  const out: Partial<Record<keyof ContractDraft, ContractIssue>> = {};
  const labour = d.kind !== null && LABOUR.includes(d.kind);
  if (!d.kind) out.kind = "required";
  if (!d.start) out.start = "required";
  if (d.kind === "FIXED_TERM" && !d.end) out.end = "required";
  else if (d.end && d.start && d.end < d.start) out.end = "endBeforeStart";
  if (d.wage === "") out.wage = "required";
  else if (labour && Number(d.wage) <= 0) out.wage = "wagePositive";
  if (!d.unit) out.unit = "required";
  if (labour && d.hours.trim() === "") out.hours = "required";
  else if (d.hours.trim() !== "" && weeklyMinutes(d.hours) === null) out.hours = "hoursRange";
  return out;
}

/** An open-ended contract has no end; any other kind may have one (a fixed-term one must). */
export const hasEnd = (kind: ContractKind | null) => kind !== "OPEN_ENDED";

/** The draft a correction starts from: the row's own terms, to change what was wrong. */
export const draftOf = (c: Contract): ContractDraft => ({
  kind: c.kind,
  start: c.start_date,
  end: c.end_date ?? "",
  wage: String(c.wage_won),
  unit: c.pay_unit,
  hours: c.weekly_minutes == null ? "" : String(c.weekly_minutes / 60),
});

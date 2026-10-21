// Which way each personnel card field is fixed (employee-ux/final spec §1.1, ER-7) and the pure parts of the E4 sheets: the
// date echo, the period table of a dated change, and how a multi-field correction is routed. The server enforces each
// rule again (PATCH /employees/{id}: high-risk fields go to a second person, the rest apply at once).

/** REV/COR: change (a dated act) or correction; COR-L: correction only; COR-H: correction only, a second person confirms. */
export type FieldClass = "rev" | "corL" | "corH";
export type FixField =
  | "name" | "sex" | "birth_date" | "address" | "hire_date" | "group_service_start_date" | "probation_end_date" | "employee_number"
  | "grade" | "position" | "title" | "job" | "family" | "employment_type";

export const FIELD_CLASS: Record<FixField, FieldClass> = {
  name: "rev",
  address: "rev",
  grade: "rev",
  position: "rev",
  title: "rev",
  job: "rev",
  family: "rev",
  employment_type: "rev",
  sex: "corL",
  probation_end_date: "corH",
  birth_date: "corH",
  hire_date: "corH",
  group_service_start_date: "corH",
  employee_number: "corH",
};

/** The change a REV field takes (the act that records it with a date); null when no dated act serves it yet. */
export const CHANGE_ACT: Partial<Record<FixField, "PROMOTE" | "APPOINT" | "EMPLOYMENT_TYPE_CHANGE">> = {
  grade: "PROMOTE",
  position: "PROMOTE",
  title: "APPOINT",
  job: "APPOINT",
  family: "APPOINT",
  employment_type: "EMPLOYMENT_TYPE_CHANGE",
};

/** The tenant list and API correction field for each catalog-valued card field. */
export const CATALOG_KIND = { grade: "GRADE", position: "TITLE", title: "POSITION", job: "JOB", family: "JOB_FAMILY" } as const;
export const CATALOG_FIELD = { grade: "grade_id", position: "job_title_id", title: "position_kind_id", family: "job_family_id" } as const;
export const correctionField = (field: FixField): string => field in CATALOG_FIELD ? CATALOG_FIELD[field as keyof typeof CATALOG_FIELD] : field;

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** Days from `a` to `b` (both YYYY-MM-DD), negative when `b` is earlier. */
export const dayDiff = (a: string, b: string) => Math.round((utc(b) - utc(a)) / DAY);
export const isDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(utc(d)) && new Date(utc(d)).toISOString().slice(0, 10) === d;

/** The first day of the month after `today`. */
export function nextMonthFirst(today: string): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
}
/** The day before `d`. */
export const dayBefore = (d: string) => new Date(utc(d) - DAY).toISOString().slice(0, 10);

/**
 * "by period" of a dated change, from the hire date (D-17): an earlier value (`past`, before the change that set the
 * current one) when there is one, the current period closing the day before `from`, and the new one opening on it.
 */
export function periods(current: { from: string | null; value: string }, next: { from: string; value: string }, past?: { from: string; value: string }) {
  return [
    ...(past && current.from ? [{ from: past.from, to: dayBefore(current.from), value: past.value, state: "past" as const }] : []),
    { from: current.from, to: dayBefore(next.from), value: current.value, state: "closing" as const },
    { from: next.from, to: null, value: next.value, state: "new" as const },
  ];
}

/**
 * The fields whose correction a second person confirms when one exists (PATCH /employees/{id}: hire_date, birth_date,
 * employee_number, employment_type, probation_end_date; group start date once recorded). The rest apply at once.
 */
export const HIGH_RISK: ReadonlySet<FixField> = new Set(["hire_date", "birth_date", "employee_number", "employment_type", "probation_end_date", "group_service_start_date"]);

/** How a field in a multi-field correction is recorded: at once, waiting for a second person, or handed to a personnel action. */
export type Route = "now" | "second" | "act";
export const routeOf = (f: FixField | "unit"): Route => (f === "unit" ? "act" : HIGH_RISK.has(f) ? "second" : "now");
export const routeCounts = (fields: readonly (FixField | "unit")[]) => ({
  now: fields.filter((f) => routeOf(f) === "now").length,
  second: fields.filter((f) => routeOf(f) === "second").length,
  act: fields.filter((f) => routeOf(f) === "act").length,
});

/** Why a field is corrected (the ledger keeps the code); none is preselected. */
export const FIX_REASONS = ["INPUT_ERROR", "SOURCE_MISMATCH", "IMPORTED_WRONG", "SELF_REQUEST", "OTHER"] as const;

/** A typed date as YYYY-MM-DD: accepts 2026-10-12, 2026.10.12, 2026/10/12 and 20261012; null when it is not a calendar day. */
export function normalizeDate(typed: string): string | null {
  const d = typed.trim().replace(/[./\s]+/g, "-").replace(/-$/, "");
  const m = /^(\d{4})-?(\d{1,2})-?(\d{1,2})$/.exec(d);
  if (!m) return null;
  const iso = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  return isDate(iso) ? iso : null;
}

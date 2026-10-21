// The workplace close plan as the sheet edits it (UX-R2 ENDS): a plan for every person and every department directly under the
// workplace, defaults by department, what is still missing (the one thing a disabled commit names), the preview's counts and the
// request. Pure; no copy.
import type { StructureNode } from "@console/api/pending";
import type { components } from "@console/api/schema";
import { factsBody, factsMissing, type GroupFacts } from "../../group-transfer/domain/facts";

export type ClosePlanView = components["schemas"]["WorkplaceClosePlanView"];
export type CloseJob = components["schemas"]["WorkplaceCloseJob"];
export type ClosePlanRequest = components["schemas"]["WorkplaceClosePlanRequest"];
export type ClosePerson = ClosePlanView["people"][number];
export type CloseUnit = ClosePlanView["units"][number];

export type ExitReason = "CLOSURE" | "INSOLVENCY";
/**
 * `with`: stays in their department, which moves to another workplace. `to`: transfer to an org unit (a department, or a workplace's own unit;
 * empty until it is chosen). `group`: a group transfer (decision #30) to an org unit `to` at workplace `workplaceId` of another legal
 * entity `entity`, with the person's own consent and continuity; one person at a time (each consents for themself).
 */
export type GroupPlan = { kind: "group"; entity: string; to: string; workplaceId: string; facts: GroupFacts };
export type PersonPlan = { kind: "with" } | { kind: "to"; to: string } | { kind: "exit"; reason: ExitReason } | GroupPlan;
/** `move`: under another workplace's own unit or one of its department (`to` empty until it is chosen). */
export type UnitPlan = { kind: "move"; to: string } | { kind: "dissolve" };
export type Draft = { people: Readonly<Record<string, PersonPlan>>; units: Readonly<Record<string, UnitPlan>> };
export const EMPTY: Draft = { people: {}, units: {} };

/** The department directly under the workplace (each carries everything under it), in the chart's order as the server lists them. */
export const topUnits = (v: ClosePlanView): CloseUnit[] => v.units.filter((u) => u.parent_org_unit_id === v.site_org_unit_id);

/** The top department a unit sits in (itself when it is one); none for the workplace's own unit. */
export function topOf(v: ClosePlanView, unit: string | null | undefined): string | undefined {
  const byId = new Map(v.units.map((u) => [u.org_unit_id, u]));
  let at = unit ? byId.get(unit) : undefined;
  while (at && at.parent_org_unit_id !== v.site_org_unit_id) at = at.parent_org_unit_id ? byId.get(at.parent_org_unit_id) : undefined;
  return at?.org_unit_id;
}

/** People by top department ("" = placed with no department), in the order the department are listed. */
export function groups(v: ClosePlanView): { unit?: CloseUnit; people: ClosePerson[] }[] {
  const by = new Map<string, ClosePerson[]>();
  for (const p of v.people) {
    const k = topOf(v, p.org_unit_id) ?? "";
    by.set(k, [...(by.get(k) ?? []), p]);
  }
  return [...topUnits(v).map((u) => ({ unit: u, people: by.get(u.org_unit_id) ?? [] })), ...(by.has("") ? [{ people: by.get("")! }] : [])];
}

/** Whether "with their department" is a plan this person can have now: their top department is moved. */
export const canGoWith = (v: ClosePlanView, d: Draft, p: ClosePerson) => d.units[topOf(v, p.org_unit_id) ?? ""]?.kind === "move";

/** Whether a group transfer plan is whole: its destination and every fact (dates against the closing `date` once one is picked). */
const groupReady = (plan: GroupPlan, date: string) =>
  Boolean(plan.to && plan.workplaceId) && !Object.values(factsMissing(plan.facts, date)).some(Boolean);

/**
 * The plan that counts for a person: theirs, unless "with" lost its moved department, a transfer has no destination yet, or a group
 * transfer is not whole.
 */
const effective = (v: ClosePlanView, d: Draft, p: ClosePerson, date = "") => {
  const plan = d.people[p.employee_id];
  if (plan?.kind === "with" && !canGoWith(v, d, p)) return undefined;
  if (plan?.kind === "group" && !groupReady(plan, date)) return undefined;
  return plan?.kind === "to" && !plan.to ? undefined : plan;
};
export const planned = (v: ClosePlanView, d: Draft, p: ClosePerson) => Boolean(effective(v, d, p));

/** Set `plan` for every person in `people` (the "the same plan for all" of one department, or a selection). */
export const planAll = (d: Draft, people: readonly ClosePerson[], plan: PersonPlan): Draft => ({
  ...d,
  people: { ...d.people, ...Object.fromEntries(people.map((p) => [p.employee_id, plan])) },
});

/** The plan everyone in `people` shares, if they all share one (so a "all" choice shows what it set). */
export const shared = (d: Draft, people: readonly { employee_id: string }[]) => {
  const plans = people.map((p) => d.people[p.employee_id]);
  return plans.every((x) => JSON.stringify(x) === JSON.stringify(plans[0])) ? plans[0] : undefined;
};

/**
 * Setting a department's plan: a moved one takes its people along by default (each can still be planned otherwise); a
 * dissolved one leaves its people to be planned, and "with" stops being a plan for them.
 */
export function planUnit(v: ClosePlanView, d: Draft, unit: string, plan: UnitPlan): Draft {
  const units = { ...d.units, [unit]: plan };
  if (plan.kind !== "move") return { ...d, units };
  const members = v.people.filter((p) => topOf(v, p.org_unit_id) === unit && !d.people[p.employee_id]);
  return planAll({ ...d, units }, members, { kind: "with" });
}

/** One press: every department under `siteUnit` (another workplace's own unit) with its people, and the people with no department there too. */
export function allTo(v: ClosePlanView, siteUnit: string): Draft {
  let d: Draft = EMPTY;
  for (const u of topUnits(v)) d = planUnit(v, d, u.org_unit_id, { kind: "move", to: siteUnit });
  const direct = v.people.filter((p) => !topOf(v, p.org_unit_id));
  return planAll(d, direct, { kind: "to", to: siteUnit });
}

/** What is still missing, in the order the sheet names it. */
export type Missing =
  | { what: "role" }
  | { what: "date" }
  | { what: "unit"; name: string; count: number }
  | { what: "people"; count: number; first: string };

export function missing(v: ClosePlanView, d: Draft, date: string): Missing[] {
  const out: Missing[] = [];
  if (v.holds_entity_role) out.push({ what: "role" });
  if (!date) out.push({ what: "date" });
  const units = topUnits(v).filter((u) => {
    const plan = d.units[u.org_unit_id];
    return !plan || (plan.kind === "move" && !plan.to);
  });
  if (units.length) out.push({ what: "unit", name: units[0]!.name, count: units.length });
  const people = v.people.filter((p) => !effective(v, d, p, date));
  if (people.length) out.push({ what: "people", count: people.length, first: people[0]!.name });
  return out;
}

/** The request for a complete plan (call only when `missing` is empty). */
export function request(v: ClosePlanView, d: Draft, date: string): ClosePlanRequest {
  return {
    closed_on: date,
    units: topUnits(v).map((u) => {
      const plan = d.units[u.org_unit_id]!;
      return plan.kind === "move" ? { org_unit_id: u.org_unit_id, action: "MOVE", to_parent_id: plan.to } : { org_unit_id: u.org_unit_id, action: "DISSOLVE" };
    }),
    people: v.people.map((p) => {
      const plan = effective(v, d, p, date)!;
      if (plan.kind === "exit") return { employee_id: p.employee_id, action: "EXIT", exit_reason_code: plan.reason };
      if (plan.kind === "group")
        return { employee_id: p.employee_id, action: "GROUP_TRANSFER", to_org_unit_id: plan.to, to_workplace_id: plan.workplaceId, group_transfer: factsBody(plan.facts) };
      return { employee_id: p.employee_id, action: "TRANSFER", to_org_unit_id: plan.kind === "with" ? p.org_unit_id! : plan.to };
    }),
  };
}

/** The node (a department by its id, a workplace by its own unit's id) and the workplace it is in, under one legal entity. */
export function locate(entity: StructureNode, unit: string): { node: StructureNode; workplace: StructureNode } | undefined {
  for (const w of entity.children) {
    if (w.org_unit_id === unit || w.id === unit) return { node: w, workplace: w };
    const stack = [...w.children];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.id === unit) return { node: n, workplace: w };
      stack.push(...n.children);
    }
  }
  return undefined;
}

/** The preview: how many people land at each workplace (by name), and how many leave by each exit reason. */
export function preview(v: ClosePlanView, d: Draft, entity: StructureNode) {
  const to = new Map<string, number>();
  const exits: Record<ExitReason, number> = { CLOSURE: 0, INSOLVENCY: 0 };
  let transfers = 0;
  const where = (unit: string) => locate(entity, unit)?.workplace.name ?? "";
  for (const p of v.people) {
    const plan = effective(v, d, p);
    if (!plan) continue;
    if (plan.kind === "exit") exits[plan.reason] += 1;
    else if (plan.kind === "group") transfers += 1;
    else {
      const name = where(plan.kind === "to" ? plan.to : (d.units[topOf(v, p.org_unit_id) ?? ""] as { to: string }).to);
      if (name) to.set(name, (to.get(name) ?? 0) + 1);
    }
  }
  const moved = Object.values(d.units).filter((u) => u.kind === "move").length;
  const dissolved = Object.values(d.units).filter((u) => u.kind === "dissolve").length;
  return { to: [...to].sort((a, b) => b[1] - a[1]), exits, groups: transfers, moved, dissolved };
}

/** Final settlement (Labor Standards Act art. 36): within 14 days of the exit date, a statute, not a tenant policy. */
const SETTLE_DAYS = 14;
export const settleBy = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + SETTLE_DAYS * 86_400_000).toISOString().slice(0, 10);

/** A job's lines counted as the receipt says them. */
export const jobCounts = (lines: readonly { action: string }[]) => ({
  moves: lines.filter((l) => l.action === "TRANSFER").length,
  exits: lines.filter((l) => l.action === "EXIT").length,
  groups: lines.filter((l) => l.action === "GROUP_TRANSFER").length,
  units: lines.filter((l) => l.action === "MOVE" || l.action === "DISSOLVE").length,
});

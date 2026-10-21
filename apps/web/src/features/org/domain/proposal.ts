// What a proposal card asks for and when it is complete: pure rules, no copy (the card maps codes to text).
import type { components } from "@console/api/schema";
import { parentOf } from "../../../reference/org/present";
import { CHILD_KIND, PARENT_KINDS } from "./tree";

type S = components["schemas"];
export type Unit = S["OrgUnitHead"];
export type Kind = Unit["kind"];
export type Members = S["OrgUnitMembers"];

/** One structural change the card proposes (the contract with the unit panel). Regions and branches are retired (decisions #18, ENT-KIND MR-20). */
export type Intent =
  | { kind: "create"; parent: Unit; child: Kind }
  | { kind: "rename"; unit: Unit }
  | { kind: "move"; unit: Unit }
  | { kind: "dissolve"; unit: Unit }
  | { kind: "reassign"; unit: Unit; members: Members };
export type IntentKind = Intent["kind"];

export type Field = "name" | "parent" | "to" | "date" | "reason";
export type Values = Record<Field, string>;
export const EMPTY: Values = { name: "", parent: "", to: "", date: "", reason: "" };
export type FieldError = "required" | "unchanged" | "beforeToday";
/** The server's limit on a unit name. */
export const NAME_MAX = 120;

/** The inputs an intent asks for, in screen order (the first error is focused in this order). */
export function fieldsOf(i: Intent): Field[] {
  const what: Field[] =
    i.kind === "create" || i.kind === "rename" ? ["name"]
    : i.kind === "move" ? ["parent"]
    : i.kind === "reassign" ? ["to"]
    : [];
  return [...what, "date", "reason"];
}

/** The name an intent renames from, if it renames. */
export const currentName = (i: Intent) => (i.kind === "rename" ? i.unit.name : undefined);

/** Field errors for `fields`. `today` is the business date: the server refuses an effective date before it. */
export function validate(fields: readonly Field[], v: Values, ctx: { today: string; current?: string }): Partial<Record<Field, FieldError>> {
  const out: Partial<Record<Field, FieldError>> = {};
  for (const f of fields) {
    const value = v[f].trim();
    if (!value) out[f] = "required";
    else if (f === "name" && ctx.current !== undefined && value === ctx.current.trim()) out[f] = "unchanged";
    else if (f === "date" && value < ctx.today) out[f] = "beforeToday";
  }
  return out;
}

const fold = (s: string) => s.trim().toLocaleLowerCase();
/** Entries whose name equals `name`, ignoring case and outer spaces: a caution, not a rule (the server has none yet). */
export const namesakes = <T extends { name: string }>(name: string, among: readonly T[]): T[] =>
  fold(name) ? among.filter((x) => fold(x.name) === fold(name)) : [];

/** Active units directly under `id`. */
export function childrenOf(units: readonly Unit[], id: string): Unit[] {
  const rootId = units.find((u) => u.kind === "COMPANY")?.id;
  return units.filter((u) => u.status === "ACTIVE" && u.kind !== "COMPANY" && parentOf(u, rootId) === id);
}

/** Where a unit's members may all move: any other active unit except the company and units being dissolved. */
export function reassignTargets(units: readonly Unit[], unit: Unit, dissolving: ReadonlySet<string>) {
  const open = units.filter((u) => u.status === "ACTIVE" && u.kind !== "COMPANY" && u.id !== unit.id);
  return { options: open.filter((u) => !dissolving.has(u.id)), excluded: open.filter((u) => dissolving.has(u.id)) };
}

const day = (d: string) => new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))));
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The 1st of the month after `d` (YYYY-MM-DD). */
export const firstOfNextMonth = (d: string) => iso(new Date(Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)), 1)));
/** The first Monday after `d`, never `d` itself. */
export function nextMonday(d: string): string {
  const x = day(d);
  x.setUTCDate(x.getUTCDate() + ((8 - x.getUTCDay()) % 7 || 7));
  return iso(x);
}

/** What `act` asks for before the card reads anything more: a member move still needs its members. */
export type Target = Exclude<Intent, { kind: "reassign" }> | { kind: "reassign"; unit: Unit };

/**
 * The proposal the URL names (`act` on the selection `sel`, `kind` for a new unit), if it applies to what is
 * there now: an active target, a kind that nests under the parent. Anything else opens nothing.
 */
export function targetOf(act: string | undefined, sel: string | undefined, kind: Kind | undefined, at: { units?: readonly Unit[] }): Target | null {
  const unit = at.units?.find((u) => u.id === sel && u.status === "ACTIVE");
  switch (act) {
    case "create": {
      const child = kind ?? (unit && CHILD_KIND[unit.kind]);
      // A bare SITE is retired (MR-20): a workplace is added through its legal entity, never as an org change.
      return unit && child && child !== "SITE" && PARENT_KINDS[child]?.includes(unit.kind) ? { kind: act, parent: unit, child } : null;
    }
    case "rename": case "move": case "dissolve": case "reassign":
      return unit && unit.kind !== "COMPANY" ? { kind: act, unit } : null;
    default:
      return null;
  }
}

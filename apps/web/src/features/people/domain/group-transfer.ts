// group transfer (decision #30): where a person can go in another legal entity, why there is nowhere, and what the sheet still needs. Pure.
import type { components } from "@console/api/schema";
import type { PlaceOption } from "./register-place";
import { factsMissing, type GroupFacts } from "../../../reference/group-transfer/domain/facts";
import { entityName } from "../../../reference/entity/domain/names";

type Entity = components["schemas"]["LegalEntity"];

/**
 * The receiving side of a group transfer: `unplaced` when the person has no legal entity recorded (there is nothing to leave), `none` when
 * the reader sees no other open legal entity (`scoped`: their grant covers only their own), `noPlace` when the other legal entities have no
 * open unit to receive anyone (each named, to add one), else the units at another legal entity's open workplace.
 */
export type GroupTargets =
  | { kind: "unplaced" }
  | { kind: "none"; scoped: boolean }
  | { kind: "noPlace"; entities: { id: string; name: string }[] }
  | { kind: "ready"; options: PlaceOption[] };

export function groupTargets(from: string | null | undefined, entities: readonly Entity[], places: readonly PlaceOption[], scoped: boolean): GroupTargets {
  if (!from) return { kind: "unplaced" };
  const others = entities.filter((e) => e.id !== from && !e.closed_on);
  if (others.length === 0) return { kind: "none", scoped };
  const open = new Set(others.flatMap((e) => e.workplaces.filter((w) => !w.closed_on).map((w) => w.id)));
  const options = places.filter((o) => o.workplaceId !== null && open.has(o.workplaceId));
  return options.length > 0 ? { kind: "ready", options } : { kind: "noPlace", entities: others.map((e) => ({ id: e.id, name: entityName(e) })) };
}

/** What a group transfer sheet holds besides the date and the note: the receiving unit and workplace, and the group transfer's facts. */
export type GroupInput = GroupFacts & { unit: string; workplaceId: string };

/** Each still-missing group transfer input against the effective `date` ("" until picked): the target, then the facts. */
export const groupMissing = (v: GroupInput, date: string) => ({ target: !v.unit || !v.workplaceId, ...factsMissing(v, date) });

/**
 * How a recorded group transfer's continuity reads: all settled at the sending legal entity (the legal default, F3), all carried, or a mix
 * named dimension by dimension. A record from before the split carries one choice for all three.
 */
export function continuityShape(g: { continuity: string; annual_leave_continuity?: string; seniority_continuity?: string }): "SETTLED" | "CARRIED" | "MIXED" {
  const leave = g.annual_leave_continuity ?? g.continuity;
  const service = g.seniority_continuity ?? (g.continuity === "CARRIED" ? "CARRIED" : "RESTART");
  if (g.continuity === "SETTLED" && leave === "SETTLED" && service === "RESTART") return "SETTLED";
  if (g.continuity === "CARRIED" && leave === "CARRIED" && service === "CARRIED") return "CARRIED";
  return "MIXED";
}

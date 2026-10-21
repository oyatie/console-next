// Unplaced people (spec E8): who they are, grouped by the value the imported file gave for where they work, and the
// places that value most likely means. Pure.
import type { components } from "@console/api/schema";

type Employee = components["schemas"]["Employee"];
type Unit = components["schemas"]["OrgUnitHead"];

type QueueItem = components["schemas"]["EmployeeImportUnplacedPage"]["items"][number];
/** A queued person: the record the roster read gave (position, type, start date), with the queue's company and the
 * department text the file named. */
export type Person = Employee & { source?: string | null };

/** The server's queue line as the screen reads it (the record the roster read gave, else the line alone). */
export const fromQueue = (q: QueueItem, e?: Employee): Person => ({
  ...(e ?? ({ id: q.employee_id, name: q.name, employee_number: q.employee_number ?? undefined } as Employee)),
  legal_entity_id: q.legal_entity_id ?? e?.legal_entity_id ?? null,
  // Placed at a workplace but not in the department the file named: grouped by that department text. Without a
  // workplace at all, by the workplace value the file carried (the record's own).
  source: q.reason === "unit_unknown" ? q.source_org_unit : null,
});

/** The value the file carried for where the person works ("" when it carried none): the department text for someone
 * already at a workplace. */
export const sourceValue = (e: Person) => (e.source ?? e.worksite_name ?? e.worksite ?? e.org_unit ?? "").trim();

export type Group = { value: string; people: Person[] };
/** People grouped by source value, largest first; the people with no value last. */
export function groupBySource(people: readonly Person[]): Group[] {
  const by = new Map<string, Person[]>();
  for (const e of people) by.set(sourceValue(e), [...(by.get(sourceValue(e)) ?? []), e]);
  return [...by].map(([value, ps]) => ({ value, people: ps })).sort((a, b) => (!a.value ? 1 : !b.value ? -1 : b.people.length - a.people.length));
}

/** Two names look alike when one holds the other or they share two letters in a row. */
export function alike(a: string, b: string) {
  const x = a.replace(/\s/g, ""), y = b.replace(/\s/g, "");
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  for (let i = 0; i + 2 <= x.length; i++) if (y.includes(x.slice(i, i + 2))) return true;
  return false;
}

export type Suggestion = { unit: Unit; why: "alike" | "recent" };
/**
 * Up to five places for a source value: open places whose path (company, workplace, department) looks alike first,
 * then the ones used last.
 */
export function suggest(value: string, places: readonly { unit: Unit; text: string }[], recent: readonly string[], max = 5): Suggestion[] {
  const out: Suggestion[] = places.filter((p) => alike(value, p.text.split(" › ").slice(1).join(" "))).map((p) => ({ unit: p.unit, why: "alike" }));
  for (const id of recent) {
    const unit = places.find((p) => p.unit.id === id)?.unit;
    if (unit && !out.some((s) => s.unit.id === id)) out.push({ unit, why: "recent" });
  }
  return out.slice(0, max);
}

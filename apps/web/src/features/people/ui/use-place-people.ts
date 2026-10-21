import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { todayKst } from "../../../lib/pure/today";
import { bindAssignment, stepKey } from "../../../reference/entity/api";
import { bulkAppoint, previewBulk, refusalOf } from "../api";

type Employee = components["schemas"]["Employee"];
/** Where people go: a department or a workplace's own unit, with the company and workplace it sits at. */
export type Target = { unitId: string; entityId: string | null; workplaceId: string | null };
export type Placed = { people: Employee[]; target: Target; batchId: string };
/** Someone the server will not place, and why (r3:hire-03): named, never a count alone. */
export type Refused = { person: Employee; code: string; message: string };
/** Nothing was written: these people would be refused, and the rest can go on their own (place the rest only). */
export type Held = { refused: Refused[]; rest: Employee[]; target: Target };

const refusedOf = (people: readonly Employee[], refusals: readonly { employee_id?: unknown; code?: unknown; message?: unknown }[]): Refused[] =>
  refusals.flatMap((r) => {
    const person = people.find((p) => p.id === r.employee_id);
    return person ? [{ person, code: String(r.code ?? ""), message: String(r.message ?? "") }] : [];
  });

/**
 * Places unplaced people (spec E8): the batch is checked first (the server's own validation, nothing written), and
 * when anyone would be refused nothing is written and each refused person comes back with the reason, so the user
 * fixes them or places the rest alone (r3:hire-03). Otherwise one all-or-nothing transfer to the unit (a setup record
 * before go-live, a transfer dated today after), then each person without a company and workplace is bound to the
 * target's from their start date (the server derives none for a person who has no company yet).
 * the bindings are one call per person after the batch; a failed one is retried with the same keys.
 */
export function usePlacePeople(onDone: (p: Placed) => void, onHeld: (h: Held) => void) {
  return useCommand({
    run: async ({ people, target }: { people: Employee[]; target: Target }, key: string): Promise<Placed | Held> => {
      const body = { event_type: "TRANSFER" as const, employee_ids: people.map((e) => e.id), to_org_unit_id: target.unitId, effective_date: todayKst(), comment: t("unplaced.comment") };
      const check = await previewBulk(body);
      const held = refusedOf(people, check.refusals as { employee_id?: unknown }[]);
      if (held.length) return { refused: held, rest: people.filter((p) => !held.some((h) => h.person.id === p.id)), target };
      let batch;
      try {
        batch = await bulkAppoint(body, key);
      } catch (e) {
        // Someone changed under the check (the commit refuses all or nothing): the same named answer.
        const r = refusalOf(e);
        if (r?.code !== "bulk_lifecycle_refused") throw e;
        const late = refusedOf(people, r.events as unknown as { employee_id?: unknown }[]);
        return { refused: late, rest: people.filter((p) => !late.some((h) => h.person.id === p.id)), target };
      }
      if (target.entityId && target.workplaceId)
        for (const [i, e] of people.entries())
          if (!e.legal_entity_id)
            await bindAssignment(stepKey(key, i + 1), { employee_id: e.id, legal_entity_id: target.entityId, workplace_id: target.workplaceId, valid_from: e.hire_date ?? todayKst() });
      return { people, target, batchId: batch.batch_id };
    },
    invalidates: ["/api/v1/employees", "/api/v1/org-units", "/api/v1/legal-entities", "/api/v1/org-structure", "/api/v1/onboarding"],
    settle: true,
    onSuccess: (r) => ("refused" in r ? onHeld(r) : onDone(r)),
  });
}

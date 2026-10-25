import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { bulkAppoint, previewBulk, refusalOf } from "../api";

type Employee = components["schemas"]["Employee"];
/** Where people go: a department or a workplace's own unit, with the company and workplace it sits at. */
export type Target = { unitId: string; entityId: string | null; workplaceId: string | null };
export type Placed = { people: Employee[]; target: Target; batchId: string; effectiveDate: string };
/** Someone the server will not place, and why (r3:hire-03): named, never a count alone. */
export type Refused = { person: Employee; code: string; message: string };
/** Nothing was written: these people would be refused, and the rest can go on their own (place the rest only). */
export type Held = { refused: Refused[]; rest: Employee[]; target: Target; setup: boolean; effectiveDate: string };

const refusedOf = (people: readonly Employee[], refusals: readonly { employee_id?: unknown; code?: unknown; message?: unknown }[]): Refused[] =>
  refusals.flatMap((r) => {
    const person = people.find((p) => p.id === r.employee_id);
    return person ? [{ person, code: String(r.code ?? ""), message: String(r.message ?? "") }] : [];
  });

/**
 * Places unplaced people (spec E8): the batch is checked first (the server's own validation, nothing written), and
 * when anyone would be refused nothing is written and each refused person comes back with the reason, so the user
 * fixes them or places the rest alone (r3:hire-03). The server writes the transfer and any initial legal placement
 * in one transaction, using import's initial-start rule during setup and the chosen effective date after go-live.
 */
export function usePlacePeople(onDone: (p: Placed) => void, onHeld: (h: Held) => void) {
  return useCommand({
    run: async ({ people, target, setup, effectiveDate }: { people: Employee[]; target: Target; setup: boolean; effectiveDate: string }, key: string): Promise<Placed | Held> => {
      const body = { event_type: "TRANSFER" as const, employee_ids: people.map((e) => e.id), to_org_unit_id: target.unitId, effective_date: effectiveDate, comment: t("unplaced.comment") };
      const check = await previewBulk(body);
      const held = refusedOf(people, check.refusals as { employee_id?: unknown }[]);
      if (held.length) return { refused: held, rest: people.filter((p) => !held.some((h) => h.person.id === p.id)), target, setup, effectiveDate };
      let batch;
      try {
        batch = await bulkAppoint(body, key);
      } catch (e) {
        // Someone changed under the check (the commit refuses all or nothing): the same named answer.
        const r = refusalOf(e);
        if (r?.code !== "bulk_lifecycle_refused") throw e;
        const late = refusedOf(people, r.events as unknown as { employee_id?: unknown }[]);
        return { refused: late, rest: people.filter((p) => !late.some((h) => h.person.id === p.id)), target, setup, effectiveDate };
      }
      return { people, target, batchId: batch.batch_id, effectiveDate };
    },
    invalidates: ["/api/v1/employees", "/api/v1/org-units", "/api/v1/legal-entities", "/api/v1/org-structure", "/api/v1/onboarding"],
    settle: true,
    onSuccess: (r) => ("refused" in r ? onHeld(r) : onDone(r)),
  });
}

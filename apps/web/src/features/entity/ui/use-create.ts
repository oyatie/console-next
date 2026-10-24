import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { entitiesRef } from "../../../reference/entity/api";
import { addRegistration, createEntity, ENTITY_READS, registrationCheckAvailabilityQuery, stepKey, type CheckPreview } from "../api";
import { createProblems, crnWarns, entityBody, entityGaps, registrationBody, takenBrn } from "../domain/create";
import type { Draft } from "../domain/draft";
import { useEntityDraft } from "./use-entity-draft";
import { entityName, legalNameTaken } from "../../../reference/entity/domain/names";

/** After the entity exists: its record, or straight to its first workplace (spec S4 "create and add the first workplace"). */
export type Then = "record" | "workplace";

/**
 * The create flow's state: the draft, what the tenant already holds (taken numbers, names and count),
 * the refusals as typed, and the save. The entity is recorded first and then its certificate, each with its own
 * step key, so a retry after a failed certificate does not create the entity twice.
 */
/** Where the wizard's draft is kept on its history entries. */
export const WIZARD_DRAFT = "console.entity-wizard.draft";

export function useCreate(seed?: Partial<Draft>, persist?: { key: string; entry: unknown }) {
  const st = useEntityDraft({ scope: "entity", ...seed }, persist);
  const d = st.draft;
  const [lastPreview, setPreview] = useState<CheckPreview | null>(null);
  const preview = lastPreview && lastPreview.values.brn === d.brn && lastPreview.values.opened_on === d.openedOn && lastPreview.values.representative === (d.representatives[0] ?? "").trim() ? lastPreview : null;
  const checkAvailability = useQuery(registrationCheckAvailabilityQuery).data;
  const entities = useQuery(entitiesRef).data?.items ?? [];
  const taken = takenBrn(d.brn, entities);
  const problems = createProblems(d, { today: st.today, taken });
  const clash = legalNameTaken(d.name, entities);
  const nav = useNavigate();
  // the created entity (its id and the name it is shown by) lives in memory; a reload between a created entity
  // and a refused certificate creates the entity again on the next save. Keep it with the draft if that ever shows up.
  const [saved, setSaved] = useState<{ id: string; name: string } | null>(null);
  const save = useCommand({
    run: async (_then: Then, key: string) => {
      // The saved record's name as every surface shows it (entityName), never the draft's legal name.
      let first = saved;
      if (!first) {
        const { record } = await createEntity(stepKey(key, 0), { ...entityBody(d), ...(st.doc ? { document_id: st.doc.id } : {}) });
        first = { id: record.id, name: entityName(record) };
        setSaved(first);
      }
      const { id, name } = first;
      const reg = registrationBody(d);
      if (reg) await addRegistration(stepKey(key, 1), id, { ...reg, ...(st.doc ? { document_id: st.doc.id } : {}), ...(preview ? { check_preview: { command_id: preview.command_id, acknowledged: preview.acknowledged, status_since: preview.status_since ?? null } } : {}) });
      return { id, name, registered: reg !== null };
    },
    invalidates: ENTITY_READS,
    announce: (r) => t("entityCreate.saved", { name: r.name }),
    onSuccess: (r, then) => {
      st.forget();
      void (then === "workplace" ? nav({ to: "/org/entities/$id/workplaces/new", params: { id: r.id } }) : nav({ to: "/org/entities/$id", params: { id: r.id } }));
    },
  });
  const put = <K extends keyof Draft>(k: K, v: Draft[K]) => st.set("identity", k, v);
  return {
    ...st,
    put,
    preview,
    checkAvailability,
    setPreview,
    entities,
    /** This entity's place among the tenant's open ones ("4th entity"). */
    ordinal: entities.filter((e) => !e.closed_on).length + 1,
    taken,
    problems,
    crnWarn: crnWarns(d),
    clash,
    gaps: entityGaps(d),
    /** The certificate goes with the entity only once every value the server needs is typed. */
    registers: registrationBody(d) !== null,
    save,
  };
}
export type CreateState = ReturnType<typeof useCreate>;

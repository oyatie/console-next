import type { LegalEntity } from "@console/api/pending";

/** Which workplace's employment insurance number a person at a workplace is reported under. */
export type EiUnit = (workplaceId: string) => string;

/**
 * The main workplace when this one reports with it (PART_OF), else itself. Before the entity is read, every
 * workplace counts as its own unit.
 */
export const eiUnitOf = (e?: LegalEntity): EiUnit => (id) => {
  const r = e?.workplaces.find((w) => w.id === id)?.insurance.find((i) => i.insurer === "EI");
  return r?.unit_mode === "PART_OF" && r.main_workplace_id ? r.main_workplace_id : id;
};

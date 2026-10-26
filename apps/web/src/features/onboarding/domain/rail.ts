// Server checklist → rail groups, and the server's remedy codes → where the fix lives (design §6.2).
// Pure: the server decides each step's state, group and remedy; this only groups them and resolves links.
import type { Checklist, ChecklistStep, GoLiveItem } from "@console/api/pending";

/** The steps of each group, in the server's order; a group with no steps is left out, nothing is invented. */
export function grouped(c: Checklist) {
  const out: { key: ChecklistStep["group"]; steps: ChecklistStep[] }[] = [];
  for (const s of c.steps) {
    const last = out.at(-1);
    const g = last?.key === s.group ? last : undefined;
    if (g) g.steps.push(s);
    else out.push({ key: s.group, steps: [s] });
  }
  return out;
}

/** Done, or done with something to look at. */
export const finished = (s: ChecklistStep) => s.state === "done" || s.state === "attention";

export type Fix = { to: "/org" | "/org/entities" | "/org/entities/new" | "/setup/go-live" | "/org/changes" | "/people" | "/people/new" | "/people/unplaced" | "/access/roles/new" | "/access/grants"; search?: { view: "accounts" } | { review: "department" } };
const ENTITIES: Fix = { to: "/org/entities" };
/**
 * Where each server remedy (and step action) is fixed. A code not listed here, or one the server marks as
 * having no screen yet ("none", the pending security-contact store), renders as text only, never as a dead link.
 * The security contact acts in place, so it is not a link.
 */
const LINKS: Record<string, Fix> = {
  upload_or_enter_certificate: { to: "/org/entities/new" },
  register_legal_entity: { to: "/org/entities/new" },
  create_legal_entity: { to: "/org/entities/new" },
  confirm_legal_entity: ENTITIES,
  legal_entity_record_required: ENTITIES,
  confirm_registration: ENTITIES,
  verify_registration: ENTITIES,
  create_primary_workplace: ENTITIES,
  create_workplace: ENTITIES,
  complete_workplace: ENTITIES,
  set_primary_workplace: ENTITIES,
  attach_registration: ENTITIES,
  enter_insurance_numbers: ENTITIES,
  update_insurance: ENTITIES,
  add_department: { to: "/org" },
  assign_department: { to: "/people", search: { review: "department" } },
  review_org_changes: { to: "/org/changes" },
  invite_executive: { to: "/people", search: { view: "accounts" } },
  register_employee: { to: "/people/new" },
  map_company_names: { to: "/people/unplaced" },
  assign_departments: { to: "/people/unplaced" },
  place_people: { to: "/people/unplaced" },
  add_role: { to: "/access/roles/new" },
  grant_access_admin: { to: "/access/grants" },
  // Accepted in place on the go-live preview, by the contracting admin.
  accept_terms: { to: "/setup/go-live" },
};
export const fixFor = (code: string | null | undefined): Fix | undefined => (code ? LINKS[code] : undefined);

/** A record a preview line counts (company-53). */
export type GoLiveRecord = GoLiveItem["records"][number];
/**
 * Where a record's fix opens: its legal entity's record, with the workplace selected for a workplace (the registration,
 * social insurance and address fixes live on it). A registration is fixed on its legal entity.
 */
export const recordFix = (r: GoLiveRecord, remedy?: string) => remedy === "assign_department" ? undefined : r.kind === "employee" ? ({ to: "/people/unplaced" as const, params: {}, search: {} }) : ["legal_entity", "registration", "workplace"].includes(r.kind) ? ({
  to: "/org/entities/$id" as const,
  params: { id: r.legal_entity_id },
  search: r.kind === "workplace" ? { wp: r.id } : r.kind === "registration" && remedy === "verify_registration" ? { nts: r.id } : {},
}) : undefined;

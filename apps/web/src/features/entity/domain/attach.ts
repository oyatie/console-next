// Which workplaces still file under no certificate (org-03, catalog company-18), and which kept certificates back none. Pure.
import type { EntityDocument, LegalEntity, Workplace } from "@console/api/pending";

/** Open workplaces of open entities with no certificate linked: those with people first (registration answers remain optional), then in the stored order (org-sibling-order; a stable sort keeps it). */
export function unattached(entities: readonly LegalEntity[]): { e: LegalEntity; w: Workplace }[] {
  return entities
    .filter((e) => !e.closed_on)
    .flatMap((e) => e.workplaces.filter((w) => !w.registration_id && !w.not_registered_reason && !w.closed_on).map((w) => ({ e, w })))
    .sort((a, b) => Number(b.w.headcount > 0) - Number(a.w.headcount > 0));
}

/** A certificate kept on the entity that backs no registration yet (one attached when the entity was created): reused, never uploaded twice. */
export const unlinkedCertificates = (docs: readonly EntityDocument[]) => docs.filter((d) => d.kind === "BIZ_REG_CERT" && !d.registration_id && !d.superseded_at);

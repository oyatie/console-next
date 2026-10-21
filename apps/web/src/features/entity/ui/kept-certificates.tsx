import { useQuery } from "@tanstack/react-query";
import type { EntityDocument } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { entityDocumentsQuery } from "../api";
import { unlinkedCertificates } from "../domain/attach";

/**
 * The certificates already attached to the entity that back no registration yet (one kept when the entity was created):
 * offered first wherever a certificate is recorded, so the same original is reused, never uploaded twice. Nothing when there
 * is none.
 */
export function KeptCertificates({ entityId, doc, onDoc }: { entityId: string; doc: EntityDocument | null; onDoc: (d: EntityDocument | null) => void }) {
  const kept = unlinkedCertificates(useQuery({ ...entityDocumentsQuery(entityId), retry: false }).data?.items ?? []);
  if (kept.length === 0) return null;
  return (
    <ChoiceField
      label={t("entityReissue.evidence.kept")}
      required={false}
      options={kept.map((d) => ({ value: d.id, label: t("entityReissue.evidence.keptAt", { name: d.file_name, at: fmtDateTime(d.uploaded_at) }) }))}
      value={doc && kept.some((k) => k.id === doc.id) ? doc.id : null}
      onChange={(id) => onDoc(kept.find((d) => d.id === id) ?? null)}
    />
  );
}

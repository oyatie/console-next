import { FileText } from "lucide-react";
import type { EntityDocument } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { Marker } from "../../../ui/field/field";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { Muted } from "../../../ui/muted/muted";
import { CERT_FILES, CERT_MAX_BYTES, uploadDocument } from "../api";
import { EntityError } from "./entity-error";
import { KeptCertificates } from "./kept-certificates";
import { OpenOriginal } from "./open-original";
import s from "./record.module.css";

/**
 * The business registration certificate a registration is recorded from: one already attached to the entity, or a file attached now. Nothing is read
 * from the file (decisions #16): the facts are typed while looking at it, and the original is kept as evidence.
 */
export function CertEvidence({ entityId, doc, onDoc }: { entityId: string; doc: EntityDocument | null; onDoc: (d: EntityDocument | null) => void }) {
  const upload = useCommand({ run: (f: File) => uploadDocument(f, "BIZ_REG_CERT"), onSuccess: onDoc });
  return (
    <section className={s.editor} aria-labelledby="cert-evidence-title">
      <h3 id="cert-evidence-title" className={s.subhead}>{t("entityReissue.evidence.title")}<Marker required /></h3>
      <KeptCertificates entityId={entityId} doc={doc} onDoc={onDoc} />
      <FileDrop
        label={t("entityReissue.evidence.drop")}
        accept={CERT_FILES}
        maxBytes={CERT_MAX_BYTES}
        onFiles={([f]) => f && upload.mutate(f)}
        busy={upload.isPending ? t("entityCreate.original.uploading") : undefined}
      >
        {doc && (
          <div className="row" role="status">
            <FileText size={14} aria-hidden /> {t("entityReissue.evidence.attached", { name: doc.file_name })} <OpenOriginal doc={doc} />
          </div>
        )}
      </FileDrop>
      <Muted>{t("entityReissue.evidence.typed")}</Muted>
      <EntityError error={upload.error} />
    </section>
  );
}

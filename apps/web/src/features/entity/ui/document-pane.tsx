import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, RefreshCw } from "lucide-react";
import type { EntityDocument } from "@console/api/pending";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { CERT_FILES, CERT_MAX_BYTES, unserved, uploadDocument } from "../api";
import s from "./entity.module.css";

/**
 * The certificate beside the form (design §6.3): upload it and type the form while looking at it. The file is
 * kept as tenant evidence; nothing is read from it (decisions #16).
 */
export function DocumentPane({ doc, onUploaded, initial }: { doc: EntityDocument | null; onUploaded: (id: string | null) => void; manual: boolean; initial?: File[] | null }) {
  const [file, setFile] = useState<File | null>(initial?.[0] ?? null);
  const upload = useCommand({ run: (f: File) => uploadDocument(f, "BIZ_REG_CERT"), onSuccess: (d) => onUploaded(d.id) });
  // The preview is the local file: shown at once, and never fetched back from the server.
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const take = ([f]: File[]) => {
    if (!f) return;
    setFile(f);
    onUploaded(null);
    upload.mutate(f);
  };
  // A file dropped on the start screen is uploaded once, as the pane opens.
  const first = initial?.[0];
  const sent = useRef<File | null>(null);
  useEffect(() => {
    if (!first || sent.current === first) return;
    sent.current = first;
    upload.mutate(first);
  });
  // A server that does not keep documents yet: the local file stays beside the form, and the pane says it is not kept.
  const notKept = unserved(upload.error);
  const status = doc ? "KEPT" : upload.isPending ? "UPLOADING" : notKept ? "NOT_KEPT" : null;

  if (!file)
    return (
      <div className={s.pane}>
        <FileDrop label={t("entity.doc.drop")}  accept={CERT_FILES} maxBytes={CERT_MAX_BYTES} onFiles={take} />
      </div>
    );
  return (
    <div className={s.pane} aria-labelledby="doc-title">
      <div className="row">
        <FileText size={16} aria-hidden />
        <h2 id="doc-title" className={s.paneTitle}>{file.name}</h2>
        <Button variant="ghost" onClick={() => (setFile(null), onUploaded(null))}>
          <RefreshCw size={16} aria-hidden /> {t("entity.doc.replace")}
        </Button>
      </div>
      <p className={s.status} role="status">
        {status === "UPLOADING" ? t("entity.doc.uploading")
        : status === "KEPT" ? t("entity.doc.kept")
        : status === "NOT_KEPT" ? t("entity.doc.notKept")
        : null}
      </p>
      {!notKept && <EntityError error={upload.error} />}
      {url && (file.type === "application/pdf" ? (
        <object className={s.preview} data={url} type="application/pdf" aria-label={t("entity.doc.preview")}>
          <p className="muted">{t("entity.doc.noPdfPreview")}</p>
        </object>
      ) : (
        <img className={s.preview} src={url} alt={t("entity.doc.preview")} />
      ))}
    </div>
  );
}

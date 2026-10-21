import { useEffect, useMemo, useState } from "react";
import { Ban, Check, Circle, Eye, FileText, PencilLine, TriangleAlert } from "lucide-react";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { EntityError } from "./entity-error";
import { Button } from "../../../ui/button/button";
import { FileDrop } from "../../../ui/file-drop/file-drop";
import { CERT_FILES, CERT_MAX_BYTES, uploadDocument } from "../api";
import { corpItems, itemsDone, type ItemState } from "../domain/create";
import type { CreateState } from "./use-create";
import s from "./entity-create.module.css";
import { Muted } from "../../../ui/muted/muted";

/** The kept original (evidence only: nothing is read from it, decisions #16), beside the form. */
export function OriginalCard({ c }: { c: CreateState }) {
  const [file, setFile] = useState<File | null>(null);
  const upload = useCommand({ run: (f: File) => uploadDocument(f, "BIZ_REG_CERT"), onSuccess: (d) => c.setDocId(d.id) });
  // The preview is the local file, never fetched back from the server.
  const url = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <section className={`card ${s.side}`} aria-labelledby="original-title">
      <div className={s.cardHead}><h2 id="original-title" className={s.cardTitle}>{t("entityCreate.original.title")}</h2></div>
      <div className={s.cardBody}>
        {/* No OCR or tax-office lookup in the MVP (decision #29): the upload fills nothing, and says so where it lands. */}
        {c.doc && file ? (
          <>
            <div className={s.doc}>
              <span className={s.thumb} aria-hidden><FileText size={24} /></span>
              <span>
                <b>{c.doc.file_name}</b>
                <Muted>{t("entityCreate.original.meta", { kb: fmtNumber(Math.round(file.size / 1024)) })}</Muted>
                {url && <Button variant="ghost" onClick={() => window.open(url, "_blank", "noopener")}><Eye size={16} aria-hidden /> {t("entityCreate.original.view")}</Button>}
              </span>
            </div>
            <p className="muted" role="status">{t("entityCreate.original.typed")}</p>
          </>
        ) : (
          <FileDrop label={t("entityCreate.original.drop")} hint={t("entityCreate.original.hint")} accept={CERT_FILES} maxBytes={CERT_MAX_BYTES} onFiles={([f]) => f && (setFile(f), upload.mutate(f))} busy={upload.isPending ? t("entityCreate.original.uploading") : undefined} />
        )}
        <EntityError error={upload.error} />
      </div>
    </section>
  );
}

const ICON: Record<ItemState, typeof Check> = { ok: Check, warn: TriangleAlert, err: TriangleAlert, todo: Circle, na: Circle };

/** Every certificate item and where it stands (spec S4 "certificate items 12/14"); a refused one says "fix". */
export function CertChecklist({ c }: { c: CreateState }) {
  const items = corpItems(c.draft, c.problems, c.brnClasses);
  return (
    <section className={`card ${s.side}`} aria-labelledby="items-title">
      <div className={s.cardHead}>
        <h2 id="items-title" className={s.cardTitle}>{t("entityCreate.items.title")}</h2>
        <span className={s.count}>{t("entityCreate.items.done", { done: itemsDone(items), total: items.length })}</span>
      </div>
      <ul className={s.mlist}>
        {items.map((i) => {
          const Icon = i.key === "businessAddress" && c.draft.businessAddress === null ? PencilLine : ICON[i.state];
          return (
            <li key={i.key} data-state={i.state}>
              <Icon size={14} aria-hidden className={s.mark} />
              <span>{i.no ? `${i.no} ` : ""}{t(`entityCreate.items.${i.key}`)}</span>
              {i.state !== "ok" && <span className={s.r}>{t(`entityCreate.items.state.${i.state}`)}</span>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** What is never asked of an individual or a unique-number organization, named so a reviewer sees it was decided, not forgotten. */
export function NotCollected({ c }: { c: CreateState }) {
  const ind = c.draft.bizKind === "INDIVIDUAL";
  const items = ind ? (["birthDate", "coOwnerRrn", "ownerAddress"] as const) : (["representativeRrn", "ownerAddress"] as const);
  return (
    <>
      <section className={`card ${s.side}`} aria-labelledby="skip-title">
        <div className={s.cardHead}><h2 id="skip-title" className={s.cardTitle}>{t("entityCreate.skip.title")}</h2></div>
        <ul className={s.mlist}>
          {items.map((k) => <li key={k}><Ban size={14} aria-hidden className={s.mark} /><span>{t(`entityCreate.skip.${k}`)}</span></li>)}
        </ul>
      </section>
    </>
  );
}

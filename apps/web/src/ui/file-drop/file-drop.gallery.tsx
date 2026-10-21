import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { FileDrop } from "./file-drop";

export const order = 219;
const DOCS = [{ mime: "application/pdf", ext: "PDF" }, { mime: "image/jpeg", ext: "JPG" }, { mime: "image/png", ext: "PNG" }];

export default function FileDropGallery() {
  const [name, setName] = useState<string | null>(null);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.fileDrop")}</h2>
      <div className="grid-3">
        <FileDrop label={tg("drop.cert")} accept={DOCS} maxBytes={10 * 1048576} onFiles={([f]) => setName(f?.name ?? null)}>
          {name && <span className="muted">{name}</span>}
        </FileDrop>
        <FileDrop label={tg("drop.cert")} accept={DOCS} maxBytes={10 * 1048576} onFiles={() => {}} busy={tg("drop.reading")} />
        <FileDrop label={tg("drop.many")} accept={DOCS} maxBytes={10 * 1048576} multiple onFiles={() => {}} error={tg("drop.serverError")} />
      </div>
    </section>
  );
}

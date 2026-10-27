import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { Field } from "../field/field";
import { TextArea } from "../field/text-area";
import { Sheet } from "./sheet";

export const order = 218;

/** A side sheet with its consequence foot over the actions; the long-text control inside a Field. */
export default function SheetGallery() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.sheet")}</h2>
      <Field label={tg("sheet.reason")} required hint={tg("sheet.reasonHint")}>
        {(p) => <TextArea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      <div>
        <Button onClick={() => setOpen(true)}>{tg("sheet.open")}</Button>
      </div>
      <Sheet
        open={open}
        size="lg"
        kicker={tg("sample.company")}
        title={tg("sheet.title")}
        subtitle={tg("sheet.subtitle")}
        onClose={() => setOpen(false)}
        consequence={
          <>
            <span>{tg("sheet.consequence")}</span>
            <span className="muted">{tg("sheet.atomic")}</span>
          </>
        }
        actions={
          <>
            <Button onClick={() => setOpen(false)}>{t("common.back")}</Button>
            <Button variant="primary" onClick={() => setOpen(false)}>{tg("sheet.commit")}</Button>
          </>
        }
      >
        <Field label={tg("sheet.reason")} required>
          {(p) => <TextArea {...p} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
      </Sheet>
    </section>
  );
}

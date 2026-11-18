import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { Field, TextInput } from "../field/field";
import { SectionConfirm } from "./section-confirm";

export const order = 220;

export default function SectionConfirmGallery() {
  const [ok, setOk] = useState(false);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.sectionConfirm")}</h2>
      <SectionConfirm title={tg("confirm.registration")} owner={tg("confirm.ownerCert")} needsConfirm confirmed={ok} onConfirm={() => setOk(true)} summary={tg("confirm.summary")}>
        <Field label={tg("confirm.tradeName")} required>
          {(p) => <TextInput {...p} defaultValue={tg("sample.company")} />}
        </Field>
      </SectionConfirm>
      <SectionConfirm title={tg("confirm.registry")} owner={tg("confirm.ownerEntity")} missing={2} needsConfirm onConfirm={() => {}} defaultOpen={false} summary={tg("confirm.registrySummary")}>
        <span />
      </SectionConfirm>
    </section>
  );
}

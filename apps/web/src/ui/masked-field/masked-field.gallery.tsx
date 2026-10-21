import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { FORMATS } from "../../lib/pure/formats";
import { Chip } from "../chip";
import { MaskedField } from "./masked-field";

export const order = 95;

export default function MaskedFieldGallery() {
  const [brn, setBrn] = useState("");
  const [bad, setBad] = useState("0008162516");
  const [crn, setCrn] = useState("0001110123459");
  const [phone, setPhone] = useState("010-1234-0001");
  const [ins, setIns] = useState("12345678901");
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.masked")}</h2>
      <div className="grid-3">
        <MaskedField label={tg("masked.brn")} required format={FORMATS.bizRegNo} value={brn} onChange={setBrn} example="123-45-67890" />
        <MaskedField
          label={tg("masked.brn")}
          required
          format={FORMATS.bizRegNo}
          value={bad}
          onChange={setBad}
          warning={FORMATS.bizRegNo.warnings(bad).length ? tg("masked.checksum") : undefined}
          status={<Chip tone="ok">{tg("masked.continuing")}</Chip>}
        />
        <MaskedField label={tg("masked.crn")} required format={FORMATS.corpRegNo} value={crn} onChange={setCrn} error={tg("masked.crnError")} />
        <MaskedField label={tg("field.phone")} required format={FORMATS.phone} value={phone} onChange={setPhone} hint={tg("field.phoneHint")} />
        <MaskedField label={tg("masked.ins")} required={false} format={FORMATS.insuranceNo} value={ins} onChange={setIns} />
      </div>
    </section>
  );
}

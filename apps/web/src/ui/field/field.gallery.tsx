import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { DerivedValue } from "./derived-value";
import { Field, TextInput } from "./field";
import { SelectInput } from "./select-input";

export const order = 90;

export default function FieldGallery() {
  const [overridden, setOverridden] = useState(true);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.field")}</h2>
      <div className="grid-3">
        <Field label={tg("field.pay")} required unit={tg("field.payUnit")} hint={tg("field.payHint")} example={tg("field.payExample")}>
          {(p) => <TextInput {...p} inputMode="numeric" />}
        </Field>
        <Field label={tg("field.phone")} required={false} hint={tg("field.phoneHint")} example={tg("field.phoneExample")}>
          {(p) => <TextInput {...p} type="tel" />}
        </Field>
        <Field label={tg("field.pay")} required unit={tg("field.payUnit")} error={tg("field.payLow")}>
          {(p) => <TextInput {...p} inputMode="numeric" defaultValue="2,000,000" />}
        </Field>
        <Field label={tg("form.number")} required error={tg("form.numberError")}>
          {(p) => <TextInput {...p} defaultValue="HK 0001" />}
        </Field>
        <Field label={tg("choice.position")} required error={tg("choice.positionError")}>
          {(p) => (
            <SelectInput {...p} defaultValue="">
              <option value="" disabled>{t("uiChoice.placeholder", { label: tg("choice.position") })}</option>
              {tg("choice.positions").split(",").map((x) => <option key={x}>{x}</option>)}
            </SelectInput>
          )}
        </Field>
        <DerivedValue label={tg("field.lossDate")} value={tg("field.lossValue")} basis={tg("field.lossBasis")} onOverride={() => undefined} />
        <DerivedValue
          label={tg("field.avgPeriod")}
          value={tg("field.avgValue")}
          basis={tg("field.avgBasis")}
          override={overridden ? tg("field.avgOverride") : undefined}
          onOverride={() => setOverridden(true)}
          onRevert={() => setOverridden(false)}
        />
      </div>
    </section>
  );
}

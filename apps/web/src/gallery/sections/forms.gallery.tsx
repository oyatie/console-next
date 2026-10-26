import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { EMPLOYMENT_TYPE, label } from "../../lib/labels";
import { ActionBar } from "../../ui/action-bar/action-bar";
import { Button, Check, Form } from "../../ui/button/button";
import { DateInput } from "../../ui/date/date-input";
import { Field, TextInput } from "../../ui/field/field";
import { SelectInput } from "../../ui/field/select-input";
import { TextArea } from "../../ui/field/text-area";
import { Section } from "../Section";

export const order = 80;

/** A form from the canonical pieces: Field (label, marker, hint, error) around each control, the attestation Check, the foot. */
export default function Forms() {
  const [checked, setChecked] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  return (
    <Section title={tg("section.forms")}>
      <Form className="form form--wide" onSubmit={() => setSubmitted(true)}>
        <div className="grid-3">
          <Field id="name-field" label={tg("form.name")} required>{(p) => <TextInput {...p} value={name} onChange={e => setName(e.target.value)} />}</Field>
          <Field label={tg("form.type")} required>
            {(p) => (
              <SelectInput {...p} defaultValue="CONTRACT">
                {EMPLOYMENT_TYPE.values.map((v) => <option key={v} value={v}>{label(EMPLOYMENT_TYPE, v)}</option>)}
              </SelectInput>
            )}
          </Field>
          <Field label={tg("form.date")} required>{(p) => <DateInput {...p} value="2026-10-01" onChange={() => undefined} />}</Field>
          <Field id="number-field" label={tg("form.number")} required hint={tg("form.numberError")}>{(p) => <TextInput {...p} value={number} onChange={e => setNumber(e.target.value)} />}</Field>
        </div>
        <Field label={tg("form.note")} required={false}>{(p) => <TextArea {...p} defaultValue={tg("empty.reason")} />}</Field>
        <Check checked={checked} onChange={setChecked}>{tg("form.ack")}</Check>
        {submitted && <div className="muted" role="status">{tg("form.submitted")}</div>}
        <ActionBar
          actions={
            <>
              <Button disabled>{tg("form.saveDraft")}</Button>
              <Button type="submit" variant="primary" disabled={!checked}>{tg("form.submit")}</Button>
            </>
          }
        />
      </Form>
    </Section>
  );
}

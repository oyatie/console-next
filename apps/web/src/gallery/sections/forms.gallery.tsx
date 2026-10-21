import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { EMPLOYMENT_TYPE, label } from "../../lib/labels";
import { ActionBar } from "../../ui/action-bar/action-bar";
import { Button, Check, Form } from "../../ui/button/button";
import { Field, TextInput } from "../../ui/field/field";
import { SelectInput } from "../../ui/field/select-input";
import { TextArea } from "../../ui/field/text-area";
import { Section } from "../Section";

export const order = 80;

/** A form from the canonical pieces: Field (label, marker, hint, error) around each control, the attestation Check, the foot. */
export default function Forms() {
  const [checked, setChecked] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  return (
    <Section title={tg("section.forms")}>
      <Form className="form form--wide" onSubmit={() => setSubmitted(true)}>
        <div className="grid-3">
          <Field label={tg("form.name")} required>{(p) => <TextInput {...p} defaultValue={tg("sample.longName")} />}</Field>
          <Field label={tg("form.type")} required>
            {(p) => (
              <SelectInput {...p} defaultValue="CONTRACT">
                {EMPLOYMENT_TYPE.values.map((v) => <option key={v} value={v}>{label(EMPLOYMENT_TYPE, v)}</option>)}
              </SelectInput>
            )}
          </Field>
          <Field label={tg("form.date")} required>{(p) => <TextInput {...p} type="date" defaultValue="2026-10-01" />}</Field>
          <Field label={tg("form.number")} required={false} error={tg("form.numberError")}>{(p) => <TextInput {...p} defaultValue="HK 0001" />}</Field>
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

// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { Field, TextInput } from "../field/field";
import { commitLabel } from "./actions";
import { Composer } from "./composer";

export const order = 212;
const examples = [
  { title: "composer.action.orgRename", kind: "orgRename", layout: "drawer", mode: "apply" },
  { title: "composer.action.TRANSFER", kind: "TRANSFER", layout: "drawer", mode: "request" },
  { title: "composer.action.registration", kind: "ONBOARD", layout: "page", mode: "apply" },
  { title: "composer.action.LEAVE_OF_ABSENCE", kind: "LEAVE_OF_ABSENCE", layout: "page", mode: "request" },
] as const;

export default function Composers() {
  const [example, setExample] = useState<typeof examples[number]>();
  return <section className="card gallery__section">
    <h2 className="toolbar__title">{t("composer.section.approvals")}</h2>
    <div className="row wrap">{examples.map((item) => <Button key={item.kind} onClick={() => setExample(item)}>{commitLabel(item)}</Button>)}</div>
    {example && <Composer title={t(example.title)} layout={example.layout} action={example} onClose={() => setExample(undefined)} onSubmit={() => false}
      routing={example.mode === "request"
        ? { routed: true, steps: [{ key: "resolved-role", who: tg("sample.position"), state: "waiting" }] }
        : { routed: false, why: tg("composer.policyReason") }}
      sections={{ preflight: tg("form.ack"), effects: tg("form.submitted") }}>
      <Field label={tg("form.name")} required>{(p) => <TextInput {...p} defaultValue={tg("sample.longName")} />}</Field>
    </Composer>}
  </section>;
}

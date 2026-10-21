import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { Button, ToggleButton } from "./button";

export const order = 80;

/** The variants, the native disabled state (never for a hard block: see DisabledReason), and a toggle (aria-pressed). */
export default function Buttons() {
  const [on, setOn] = useState(true);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.button")}</h2>
      <div className="row">
        <Button variant="primary">{tg("button.primary")}</Button>
        <Button>{tg("form.saveDraft")}</Button>
        <Button variant="ghost">{tg("button.ghost")}</Button>
        <Button variant="danger">{tg("button.danger")}</Button>
        <Button variant="ghost-danger">{tg("button.danger")}</Button>
        <Button disabled>{tg("form.saveDraft")}</Button>
        <ToggleButton pressed={on} onClick={() => setOn(!on)}>{tg("button.toggle")}</ToggleButton>
      </div>
    </section>
  );
}

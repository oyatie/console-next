import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ChoiceField } from "./choice-field";

export const order = 110;

const ACTS = (["TRANSFER", "PROMOTE", "LEAVE_OF_ABSENCE"] as const).map((v) => ({ value: v, label: t(`enum.lifecycleEvent.${v}`) }));
const TYPES = (["REGULAR", "CONTRACT", "PART_TIME", "INTERN"] as const).map((v) => ({
  value: v,
  label: t(`enum.employmentType.${v}`),
  description: tg(`choice.${v}`),
}));
const POSITIONS = tg("choice.positions").split(",").map((label, i) => ({ value: `P${i}`, label }));

export default function ChoiceGallery() {
  const [act, setAct] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [position, setPosition] = useState<string | null>(null);
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.choice")}</h2>
      <div className="grid-3">
        <ChoiceField label={tg("choice.act")} required options={ACTS} value={act} onChange={setAct} />
        <ChoiceField label={tg("form.type")} required options={TYPES} value={type} onChange={setType} footer={<span className="muted">{tg("choice.typeFooter")}</span>} />
        <ChoiceField
          label={tg("choice.position")}
          required
          options={POSITIONS}
          value={position}
          onChange={setPosition}
          error={position ? undefined : tg("choice.positionError")}
        />
      </div>
    </section>
  );
}

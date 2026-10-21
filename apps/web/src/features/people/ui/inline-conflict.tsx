import { useId, useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { Banner } from "../../../ui/banner/banner";
import s from "./card.module.css";

export type FieldConflict = { mine: string; before: string; onKeep: () => void; onTheirs: () => void };

/**
 * E12-conflict at the field (spec §1.3 concurrency): someone saved this person first. Nothing was overwritten; the typed
 * value is kept, both values show, and the choice has no default. Other fields were never blocked.
 */
export function InlineConflict({ field, now, c }: { field: string; now: string; c: FieldConflict }) {
  const [pick, setPick] = useState<string | null>(null);
  const id = `conflict-${field}`;
  const head = useId();
  // The server refuses on the person's version (no per-field 409 yet): say whether this field itself moved.
  const same = now === c.before;
  return (
    <div className={s.inlineConflict} role="group" aria-labelledby={head}>
      <Banner tone="warn">
      <p className={s.conflictHead} id={head}><b>{t(same ? "empCard.conflict.headOther" : "empCard.conflict.head", { field })}</b> <span className={s.s12}>{t("empCard.conflict.kept")}</span></p>
      <ChipChoice
        id={id}
        label={t("empCard.conflict.which")}
        value={pick}
        onChange={setPick}
        options={[
          { value: "mine", label: t("empCard.conflict.mine", { value: c.mine || "—" }) },
          { value: "theirs", label: t("empCard.conflict.theirs", { value: now || "—" }) },
        ]}
      />
      <p className={s.s12}>{t("empCard.conflict.others")}</p>
      <div className={s.popActs}>
        <Button variant="primary" aria-disabled={pick ? undefined : true} onClick={() => (pick === "mine" ? c.onKeep() : pick === "theirs" ? c.onTheirs() : document.getElementById(id)?.querySelector<HTMLElement>("input")?.focus())}>{t("empCard.conflict.save")}</Button>
      </div>
      </Banner>
    </div>
  );
}

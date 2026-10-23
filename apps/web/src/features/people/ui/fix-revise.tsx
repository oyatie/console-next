import { useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Sheet } from "../../../ui/sheet/sheet";
import type { Correction } from "../api";
import { CHANGE_ACT, type FixField } from "../domain/fix";
import { FixChange } from "./fix-change";
import { FixCorrect } from "./fix-correct";
import { currentOf } from "./use-fix-draft";
import type { Card } from "./use-card";
import s from "./card.module.css";
import { Who } from "./card-who";

/**
 * edit on a REV/COR field (E4-grade-initial): change (it changed from a date, recorded as a personnel action) or correction (it was wrong
 * from the start) is chosen first, nothing preselected, and no field opens before that. next stays focusable and takes
 * focus to the choice while it is missing (R9).
 */
export function FixRevise({ c, field, onClose, onCorrected, onChanged }: { c: Card; field: FixField; onClose: () => void; onCorrected: (out: Correction) => void; onChanged: (message: string) => void }) {
  const [pick, setPick] = useState<"rev" | "cor" | null>(null);
  const [step, setStep] = useState<"choose" | "rev" | "cor">("choose");
  const label = t(`empFix.field.${field}`);
  const now = currentOf(c, field);
  const act = CHANGE_ACT[field];
  if (step === "cor") return <FixCorrect c={c} field={field} onClose={onClose} onDone={onCorrected} />;
  if (step === "rev" && act) return <FixChange c={c} field={field} act={act} onClose={onClose} onDone={onChanged} onCorrect={() => setStep("cor")} />;
  const next = () => (pick ? setStep(pick) : document.getElementById("fix-verb")?.querySelector<HTMLElement>("input")?.focus());
  return (
    <Sheet
      open
      kicker={<Who c={c} />}
      title={t("empFix.revise.title", { field: label })}
      subtitle={t("empFix.revise.now", { field: label, value: now.text })}
      onClose={onClose}
      consequence={
        <>
          <span><b>{t("empFix.revise.nothing")}</b></span>
          <span className={s.s12}>{t("empFix.revise.keys")}</span>
        </>
      }
      actions={
        <>

          <Button variant="primary" aria-disabled={pick ? undefined : true} onClick={next}>{t("empFix.revise.next")}</Button>
        </>
      }
    >
      <div id="fix-verb">
        <ChoiceField
          label={t("empFix.revise.what")}
          required
          value={pick}
          onChange={(x) => setPick(x as "rev" | "cor")}
          options={[
            { value: "rev", label: t("empFix.revise.rev", { field: label }), description: t("empFix.revise.rev.d", { value: now.text }), disabled: act ? undefined : t("empFix.revise.rev.unserved") },
            { value: "cor", label: t("empFix.revise.cor"), description: t("empFix.revise.cor.d", { value: now.text }) },
          ]}
        />
      </div>
    </Sheet>
  );
}

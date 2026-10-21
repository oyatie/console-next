import { Plus, X } from "lucide-react";
import type { RepresentationMode } from "@console/api/pending";
import { t } from "@console/i18n";
import { label, REPRESENTATION } from "../../../lib/labels";
import { repsAfter, type Reps } from "../domain/record-values";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { Chip } from "../../../ui/chip";
import { TextInput } from "../../../ui/field/field";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";

/** The representative rows of spec S3-revise: a leaving one is struck through with its undo, a new one is typed in place. */
export function RepsEditor({ v, set }: { v: Reps; set: (v: Reps) => void }) {
  const total = repsAfter(v).length;
  return (
    <div className={s.reps}>
      <ul className={s.repRows}>
        {v.names.map((n, i) => (
          <li key={n + i}>
            <span className={v.leaving[i] ? s.old : undefined}>{n}</span>
            <span className="grow" />
            {v.leaving[i] ? (
              <>
                <Chip tone="danger">{t("entityRecord.reps.leaving")}</Chip>
                <Button variant="ghost" onClick={() => set({ ...v, leaving: v.leaving.map((x, j) => (j === i ? false : x)) })}>{t("entityRecord.reps.restore")}</Button>
              </>
            ) : (
              <>
                <Muted>{t("entityRecord.reps.stays")}</Muted>
                <Button variant="ghost" aria-label={t("entityRecord.reps.leaveOf", { name: n })} onClick={() => set({ ...v, leaving: v.leaving.map((x, j) => (j === i ? true : x)) })}>{t("entityRecord.reps.leave")}</Button>
              </>
            )}
          </li>
        ))}
        {v.added.map((n, i) => (
          <li key={`new-${i}`}>
            <TextInput aria-label={t("entityRecord.reps.newName", { n: i + 1 })} className="grow" maxLength={100} value={n} onChange={(e) => set({ ...v, added: v.added.map((x, j) => (j === i ? e.target.value : x)) })} />
            <Chip tone="ok">{t("entityRecord.reps.appointed")}</Chip>
            <Button variant="ghost" aria-label={t("entityRecord.reps.removeNew", { n: i + 1 })} onClick={() => set({ ...v, added: v.added.filter((_, j) => j !== i) })}><X size={16} aria-hidden /></Button>
          </li>
        ))}
      </ul>
      <Button onClick={() => set({ ...v, added: [...v.added, ""] })}><Plus size={16} aria-hidden /> {t("entityRecord.reps.add")}</Button>
      {total > 1 && (
        <ChoiceField
          label={t("entityRecord.reps.mode")}
          required
          options={REPRESENTATION.values.filter((m) => m !== "SINGLE").map((m) => ({ value: m, label: label(REPRESENTATION, m) }))}
          value={v.mode}
          onChange={(m) => set({ ...v, mode: m as RepresentationMode })}
        />
      )}
    </div>
  );
}

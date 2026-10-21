import { Plus, X } from "lucide-react";
import { t } from "@console/i18n";
import { DIRECTOR_ROLE, label } from "../../../lib/labels";
import { todayKst } from "../../../lib/pure/today";
import { Button } from "../../../ui/button/button";
import { ChoiceField } from "../../../ui/choice/choice-field";
import { DateField } from "../../../ui/date/date-field";
import { Field, TextInput } from "../../../ui/field/field";
import type { DirectorDraft } from "../domain/draft";
import s from "./record.module.css";

/** The officers in printed order: role, name and appointment date each; a row is added or removed in place. */
export function DirectorsEditor({ v, set }: { v: DirectorDraft[]; set: (v: DirectorDraft[]) => void }) {
  const row = (i: number, patch: Partial<DirectorDraft>) => set(v.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <div className={s.reps}>
      {v.map((d, i) => (
        <div key={i} className={s.director}>
          <ChoiceField label={t("entityCreate.director.role", { n: i + 1 })} required options={DIRECTOR_ROLE.values.map((r) => ({ value: r, label: label(DIRECTOR_ROLE, r) }))} value={d.role} onChange={(r) => row(i, { role: r as DirectorDraft["role"] })} />
          <Field label={t("entityCreate.director.name", { n: i + 1 })} required>{(f) => <TextInput {...f} maxLength={100} value={d.name} onChange={(e) => row(i, { name: e.target.value })} />}</Field>
          <DateField label={t("entityCreate.director.appointedOn", { n: i + 1 })} required={false} value={d.appointedOn} onChange={(x) => row(i, { appointedOn: x })} today={todayKst()} />
          <Button variant="ghost" aria-label={t("entityCreate.director.remove", { n: i + 1 })} onClick={() => set(v.filter((_, j) => j !== i))}><X size={16} aria-hidden /></Button>
        </div>
      ))}
      <Button onClick={() => set([...v, { role: null, name: "", appointedOn: "" }])}><Plus size={16} aria-hidden /> {t("entityCreate.director.add")}</Button>
    </div>
  );
}

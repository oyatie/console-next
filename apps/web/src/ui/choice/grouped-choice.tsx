import type { ReactNode } from "react";
import { Label, Radio, RadioGroup } from "react-aria-components";
import { Marker } from "../field/field";
import s from "./grouped-choice.module.css";

export type ChoiceGroup = { id: string; title: ReactNode; meta?: ReactNode; options: { value: string; label: string; meta?: ReactNode; name?: string }[] };

/**
 * One pick from a list under group headings (a workplace under its company): compact rows with their counts, nothing
 * preselected. Arrow keys move within the list as in a radio group; `name` is a row's full accessible name.
 */
export function GroupedChoice({ id, label, hint, groups, value, onChange }: { id?: string; label: string; hint?: ReactNode; groups: readonly ChoiceGroup[]; value: string | null; onChange: (v: string) => void }) {
  return (
    <RadioGroup id={id} className={s.group} value={value} onChange={onChange} isRequired validationBehavior="aria">
      <Label className={s.label}>{label}<Marker required />{hint && <span className={s.hint}>{hint}</span>}</Label>
      <div className={s.box}>
        {groups.map((g) => (
          <div key={g.id}>
            <div className={s.head}><b>{g.title}</b><span className={s.grow} />{g.meta && <span className={s.hint}>{g.meta}</span>}</div>
            {g.options.map((o) => (
              <Radio key={o.value} value={o.value} className={s.row} aria-label={o.name}>
                <span className={s.dot} aria-hidden />
                <span className={s.grow}>{o.label}</span>
                {o.meta && <span className={s.hint}>{o.meta}</span>}
              </Radio>
            ))}
          </div>
        ))}
      </div>
    </RadioGroup>
  );
}

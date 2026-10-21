import { Label, Radio, RadioGroup } from "react-aria-components";
import { Marker } from "../field/field";
import s from "../reason/reason.module.css";

/**
 * One pick from a short list as pill chips (a reveal reason, a purpose, a print mode), nothing preselected. The
 * reason chips' look without their memo; `disabled` options stay listed. `id` lets a foot's "pressing goes to the field" focus it.
 */
export function ChipChoice({ id, label, options, value, onChange, required = true, invalid }: {
  id?: string;
  label: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  value: string | null;
  onChange: (v: string) => void;
  required?: boolean;
  invalid?: boolean;
}) {
  return (
    <RadioGroup id={id} className={s.group} value={value} onChange={onChange} isRequired={required} validationBehavior="aria" isInvalid={invalid} orientation="horizontal">
      <Label className={s.label}>
        {label}
        {required && <Marker required />}
      </Label>
      <div className={s.chips}>
        {options.map((o) => (
          <Radio key={o.value} value={o.value} className={s.chip} isDisabled={o.disabled}>{o.label}</Radio>
        ))}
      </div>
    </RadioGroup>
  );
}

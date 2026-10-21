import type { ReactNode } from "react";
import { Checkbox, CheckboxGroup, FieldError, Label } from "react-aria-components";
import { Check } from "lucide-react";
import { Marker } from "../field/field";
import s from "./checks.module.css";

/**
 * Statements a person confirms one by one (server-required sign-offs). Every box starts unchecked and there is no
 * "check all": each statement is read and confirmed on its own. `error` shows once a commit was tried with one missing.
 */
export function Checks({ label, items, value, onChange, error, isDisabled, required = true }: {
  label: string;
  items: readonly { id: string; label: ReactNode }[];
  value: readonly string[];
  onChange: (value: string[]) => void;
  error?: ReactNode;
  isDisabled?: boolean;
  /** False for a free pick (no marker, none needed). */
  required?: boolean;
}) {
  return (
    <CheckboxGroup className={s.group} value={[...value]} onChange={onChange} isRequired={required} isInvalid={error != null} isDisabled={isDisabled} validationBehavior="aria">
      <Label className={s.label}>{label}{required && <Marker required />}</Label>
      {items.map((i) => (
        <Checkbox key={i.id} value={i.id} className={s.item}>
          {({ isSelected }) => (
            <>
              <span className={s.box} aria-hidden="true">{isSelected && <Check size={12} strokeWidth={3} />}</span>
              <span>{i.label}</span>
            </>
          )}
        </Checkbox>
      ))}
      <FieldError className={s.error}>{error}</FieldError>
    </CheckboxGroup>
  );
}

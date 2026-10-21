import { ComboBox, FieldError, Input, ListBox, ListBoxItem, Popover, Label, Button } from "react-aria-components";
import { ChevronDown } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { UNIT_KIND, label } from "../../../lib/labels";
import { unitPath } from "../present";
import s from "../../../ui/field/field.module.css";
import { Muted } from "../../../ui/muted/muted";

type Unit = components["schemas"]["OrgUnitHead"];

/** Searchable unit picker (React Aria ComboBox: keyboard, screen reader and Korean IME safe). */
export function UnitPicker({ units, options, value, onChange, labelText = t("org.unit.picker.label"), required = true, error }: {
  units: Unit[];
  options: Unit[];
  value: string;
  onChange: (id: string) => void;
  labelText?: string;
  /** false for a filter, where no unit means every unit. */
  required?: boolean;
  /** Named on a commit attempt without a unit; the input is then marked invalid, so the form can focus it. */
  error?: string;
}) {
  return (
    <ComboBox className="field" selectedKey={value || null} onSelectionChange={(k) => onChange((k as string) ?? "")} defaultItems={options} isRequired={required} isInvalid={error != null}>
      <Label className="field__label">{labelText}</Label>
      <div className="combo">
        <Input className="field__input combo__input" placeholder={t("org.unit.picker.search")} />
        <Button className="combo__button" aria-label={t("org.unit.picker.open")}><ChevronDown size={16} aria-hidden /></Button>
      </div>
      <FieldError className={s.error}>{error}</FieldError>
      <Popover className="popover">
        <ListBox className="listbox">
          {(u: Unit) => (
            <ListBoxItem id={u.id} textValue={u.name} className="listbox__item">
              <span className="grow">{unitPath(units, u)}</span>
              <Muted>{label(UNIT_KIND, u.kind)}</Muted>
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}

import type { ReactNode } from "react";
import { Button, Label, ListBox, ListBoxItem, Popover, Select, SelectValue, Text } from "react-aria-components";
import { ChevronDown } from "lucide-react";
import s from "./select-field.module.css";

export type SelectOption = { id: string; label: string; description?: string };

/**
 * One choice from a short list in a popover (components.html §3), for a row with no room for radio cards: the trigger
 * shows the pick (or `placeholder`), the list each option with its description. Nothing is preselected; type-ahead and
 * arrow keys work as in a native select. `hideLabel`: a section label above the row already names the control.
 */
export function SelectField({ label, hideLabel = false, options, value, onChange, placeholder, icon, error, required = true }: {
  label: string;
  hideLabel?: boolean;
  options: readonly SelectOption[];
  value: string | null;
  onChange: (id: string) => void;
  placeholder: string;
  icon?: ReactNode;
  error?: ReactNode;
  required?: boolean;
}) {
  return (
    <Select className={s.select} value={value} onChange={(k) => k != null && onChange(String(k))} isRequired={required} isInvalid={error != null} placeholder={placeholder}>
      <Label className={hideLabel ? "sr-only" : s.label}>{label}</Label>
      <Button className={s.trigger}>
        {icon}
        <SelectValue className={s.value}>{({ selectedText, defaultChildren, isPlaceholder }) => (isPlaceholder ? defaultChildren : selectedText)}</SelectValue>
        <ChevronDown size={14} aria-hidden className={s.chev} />
      </Button>
      {error != null && <span className={s.error}>{error}</span>}
      <Popover className={s.pop}>
        <ListBox className={s.list}>
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} textValue={o.label} className={s.opt}>
              <Text slot="label" className={s.optLabel}>{o.label}</Text>
              {o.description && <Text slot="description" className={s.desc}>{o.description}</Text>}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </Select>
  );
}

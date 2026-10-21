import type { ReactNode } from "react";
import { Button, ComboBox, Input, ListBox, ListBoxItem, Popover } from "react-aria-components";
import { ChevronDown } from "lucide-react";
import { t } from "@console/i18n";
import s from "./path-picker.module.css";

/** One place: its full path as text (searched and shown) and a count beside it (e.g. its headcount). */
export type PathOption = { id: string; text: string; content?: ReactNode; count?: string };

/**
 * A searchable picker that reads as the chosen path (spec E3/E5/E8 company › workplace › department boxes): an icon, the path,
 * the count of the chosen option and the list opener. Labelled by `label` (its question sits above it as a group
 * label). Lists only `options`, so an invalid place is never offered. Typing opens the list even before the options
 * have loaded (they appear in it as they land) or when nothing matches (it says so).
 */
export function PathPicker({ options, value, onChange, placeholder, label, invalid, icon, openLabel }: {
  options: readonly PathOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder: string;
  label: string;
  invalid?: boolean;
  icon?: ReactNode;
  openLabel: string;
}) {
  const chosen = options.find((o) => o.id === value);
  return (
    <ComboBox className={s.picker} aria-label={label} selectedKey={value || null} onSelectionChange={(k) => onChange((k as string) ?? "")} defaultItems={options} allowsEmptyCollection isInvalid={invalid} data-chosen={chosen ? true : undefined}>
      <div className={s.box}>
        {icon != null && <span className={s.icon}>{icon}</span>}
        <Input className={s.input} placeholder={placeholder} />
        {chosen?.count != null && <span className={s.count}>{chosen.count}</span>}
        <Button className={s.button} aria-label={openLabel}><ChevronDown size={16} aria-hidden /></Button>
      </div>
      <Popover className="popover">
        <ListBox className="listbox" renderEmptyState={() => <p className={s.empty}>{t("uiChoice.noMatch")}</p>}>
          {(o: PathOption) => (
            <ListBoxItem id={o.id} textValue={o.text} className="listbox__item">
              <span className="grow">{o.content ?? o.text}</span>
              {o.count != null && <span className="muted">{o.count}</span>}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}

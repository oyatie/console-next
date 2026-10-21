import type { ReactNode } from "react";
import { ComboBox, Input, Label, ListBox, ListBoxItem, Popover, Text } from "react-aria-components";
import { Search } from "lucide-react";
import { t } from "@console/i18n";
import fieldCss from "../field/field.module.css";
import { Marker } from "../field/field";
import css from "../server-picker/server-picker.module.css";
import s from "./code-picker.module.css";

export type CodeOption = { code: string; label: string; context?: string };
/** An official code list as the server serves it: its title, version, and whether it is loaded. */
export type CodeList = { title: string; version?: string; loaded: boolean };

/**
 * A pick from an official code list (design §2.4): the code and its label are chosen by search, never typed.
 * The caller searches on the server and passes the results. The list's version shows in the footer. A list
 * that is not loaded yet never blocks: the field says so and shows `fallback` (e.g. the text as printed on
 * the certificate, or a code typed with format checks only), and the code is assigned once the list loads. With no
 * fallback the field may stay empty until then.
 */
export function CodePicker({ label, required, list, query, onQueryChange, options, value, onChange, loading, fallback, error }: {
  label: string;
  required: boolean;
  list: CodeList;
  query: string;
  onQueryChange: (q: string) => void;
  options: readonly CodeOption[];
  value: string | null;
  onChange: (code: string | null) => void;
  loading?: boolean;
  fallback?: ReactNode;
  error?: ReactNode;
}) {
  if (!list.loaded)
    return (
      <div className={s.unloaded} role="group" aria-label={label}>
        <span className={fieldCss.label}>{label}<Marker required={required} /></span>
        <span className={s.note}>{t(fallback ? "uiCodePicker.notLoaded" : "uiCodePicker.notLoadedEmpty", { list: list.title })}</span>
        {fallback}
      </div>
    );
  return (
    <ComboBox
      className={`field ${css.picker}`}
      items={options}
      inputValue={query}
      onInputChange={onQueryChange}
      selectedKey={value ?? null}
      onSelectionChange={(k) => {
        onChange(k === null ? null : String(k));
        // The input text is controlled, so the pick is written back into it (React Aria leaves it as typed).
        const o = options.find((x) => x.code === k);
        if (o) onQueryChange(o.label);
      }}
      menuTrigger="input"
      allowsEmptyCollection
      isRequired={required}
      isInvalid={error != null}
    >
      <Label className={fieldCss.label}>{label}<Marker required={required} /></Label>
      <div className={css.input}>
        <Search aria-hidden="true" className={css.icon} />
        <Input className="field__input" />
      </div>
      {error != null && <Text slot="errorMessage" className={s.error}>{error}</Text>}
      <Popover className={`popover ${css.pop}`}>
        <ListBox className="listbox" renderEmptyState={() => <div className={css.empty}>{loading ? t("uiCodePicker.loading") : t("uiCodePicker.none")}</div>}>
          {(o: CodeOption) => (
            <ListBoxItem id={o.code} textValue={`${o.code} ${o.label}`} className={`listbox__item ${css.option}`}>
              <span className={css.name}>{o.label}</span>
              <span className={css.code}>{o.code}</span>
              {o.context && <span className={css.sub}>{o.context}</span>}
            </ListBoxItem>
          )}
        </ListBox>
        <div className={css.foot}>{list.version ? t("uiCodePicker.version", { list: list.title, version: list.version }) : list.title}</div>
      </Popover>
    </ComboBox>
  );
}

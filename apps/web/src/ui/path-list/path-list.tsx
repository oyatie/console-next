import { useState, type ReactNode } from "react";
import { Input, ListBox, ListBoxItem, SearchField } from "react-aria-components";
import { Check, Search } from "lucide-react";
import s from "./path-list.module.css";

/** One place in the list: `depth` indents it; `note` sits after its name; `disabled` says why it cannot be picked; a `header` (the company) only groups. */
export type PathItem = { id: string; name: string; depth: number; icon?: ReactNode; note?: string; disabled?: string; header?: boolean };

/**
 * An always-open list of places to pick one from (spec E5/E6, where to): a search box over an indented tree, the chosen
 * one marked, places that cannot take the people listed but not selectable, with why beside them.
 */
export function PathList({ items, value, onChange, label, searchLabel, placeholder }: {
  items: readonly PathItem[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  searchLabel: string;
  placeholder: string;
}) {
  const [q, setQ] = useState("");
  const shown = q.trim() ? items.filter((i) => i.name.includes(q.trim())) : items;
  return (
    <div className={s.box}>
      <SearchField className={s.search} aria-label={searchLabel} value={q} onChange={setQ}>
        <Search size={16} aria-hidden className={s.icon} />
        <Input className={s.input} placeholder={placeholder} />
      </SearchField>
      <ListBox
        aria-label={label}
        className={s.list}
        selectionMode="single"
        selectedKeys={value ? [value] : []}
        disabledKeys={items.filter((i) => i.disabled || i.header).map((i) => i.id)}
        onSelectionChange={(keys) => {
          const [k] = [...(keys as Set<string>)];
          if (k) onChange(k);
        }}
        items={shown}
      >
        {(i) => (
          <ListBoxItem id={i.id} textValue={i.name} className={s.item} data-depth={Math.min(i.depth, 4)} data-header={i.header || undefined}>
            {({ isSelected }) => (
              <>
                {i.icon}
                <span className={s.name}>{i.name}</span>
                {(i.disabled ?? i.note) && <small className={s.note}>{i.disabled ?? i.note}</small>}
                <span className={s.grow} />
                {isSelected && <Check size={14} aria-hidden />}
              </>
            )}
          </ListBoxItem>
        )}
      </ListBox>
    </div>
  );
}

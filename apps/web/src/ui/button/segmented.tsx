import type { ReactNode } from "react";
import { ToggleButton, type ButtonSize } from "./button";
import s from "./segmented.module.css";

/**
 * A segmented control (kit .seg): two to four views or modes of one thing side by side in one bordered group, exactly
 * one pressed (a history's all / acts / corrections; a list's density). Each segment is a ToggleButton, so it reads as on/off.
 */
export function Segmented<T extends string>({ label, items, value, onChange, size }: {
  label: string;
  items: readonly { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  size?: ButtonSize;
}) {
  return (
    <span className={s.seg} role="group" aria-label={label}>
      {items.map((i) => (
        <ToggleButton key={i.id} className={s.item} size={size} pressed={value === i.id} onClick={() => i.id !== value && onChange(i.id)}>
          {i.label}
        </ToggleButton>
      ))}
    </span>
  );
}

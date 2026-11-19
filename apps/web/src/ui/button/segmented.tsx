import type { ReactNode } from "react";
import { ToggleButton, type ButtonSize } from "./button";
import s from "./segmented.module.css";

/**
 * A segmented control (kit .seg): two to four views or modes of one thing side by side in one bordered group, exactly
 * one pressed (a history's all / acts / corrections; a list's density). Each segment is a ToggleButton, so it reads as on/off.
 */
export function Segmented<T extends string>({ label, items, value, onChange, size, block }: {
  label: string;
  items: readonly {
    id: T;
    label: ReactNode;
    /** Optional decorative icon shown before the segment label. */
    icon?: ReactNode;
    /** Optional tabular count shown after the segment label. */
    count?: ReactNode;
    /** Optional attention or overdue tone while the segment is not selected. */
    tone?: "warn" | "danger";
  }[];
  value: T;
  onChange: (id: T) => void;
  size?: ButtonSize;
  /** Stretch equally across the container width (phone filter bars). */
  block?: boolean;
}) {
  return (
    <span className={s.seg} data-block={block || undefined} role="group" aria-label={label}>
      {items.map((i) => (
        <ToggleButton
          key={i.id}
          className={s.item}
          data-tone={i.tone}
          size={size}
          count={i.count}
          countTone={i.tone}
          pressed={value === i.id}
          onClick={() => i.id !== value && onChange(i.id)}
        >
          {i.icon}
          {i.label}
        </ToggleButton>
      ))}
    </span>
  );
}

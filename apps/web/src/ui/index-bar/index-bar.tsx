// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { IconButton } from "../button/button";
import s from "./index-bar.module.css";

type IndexBarItem = {
  id: string;
  label: string;
  disabled?: boolean;
};

/** Compact character index strip paired with a tabular range readout and prev/next paging controls. */
export function IndexBar({
  label,
  items,
  active,
  onSelect,
  range,
  prev,
  next,
}: {
  label: string;
  items: readonly IndexBarItem[];
  active?: string | null;
  onSelect: (id: string | null) => void;
  range?: ReactNode;
  prev?: { label: string; disabled?: boolean; onPress: () => void };
  next?: { label: string; disabled?: boolean; onPress: () => void };
}) {
  return (
    <div className={s.bar} role="region" aria-label={label}>
      <div className={s.start}>
        <bdi className={s.label}>{label}</bdi>
        <div className={s.letters} role="group" aria-label={label}>
          {items.map(item => {
            const pressed = active === item.id;
            return (
              <button
                key={item.id}
                type="button"
                className={s.letter}
                aria-pressed={pressed}
                disabled={item.disabled}
                onClick={() => onSelect(pressed ? null : item.id)}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>
      {range != null || prev || next ? (
        <div className={s.end}>
          {range != null ? <bdi className={s.range}>{range}</bdi> : null}
          {prev || next ? (
            <div className={s.pager}>
              {prev ? (
                <IconButton size="sm" variant="secondary" label={prev.label} disabled={prev.disabled} onClick={prev.onPress}>
                  <ChevronUp size={13} aria-hidden="true" />
                </IconButton>
              ) : null}
              {next ? (
                <IconButton size="sm" variant="secondary" label={next.label} disabled={next.disabled} onClick={next.onPress}>
                  <ChevronDown size={13} aria-hidden="true" />
                </IconButton>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

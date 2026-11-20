// SPDX-License-Identifier: LicenseRef-Proprietary
import { ArrowDown, ArrowUp } from "lucide-react";
import { t } from "@console/i18n";
import { Button } from "../button/button";
import s from "./sort-control.module.css";

/**
 * Command-strip sort readout and toggle: displays the active sort criterion, lets multi-field views
 * switch the sort field, and toggles ascending or descending order.
 */
export function SortControl<T extends string>({
  fields,
  field,
  direction,
  onChange,
  label,
}: {
  /** Sortable fields offered in the command strip (`1` or more). */
  fields: readonly { id: T; label: string }[];
  /** Currently active field identifier. */
  field: T;
  /** Active sort order (`"asc"` or `"desc"`). */
  direction: "asc" | "desc";
  /** Invoked whenever the sort field or direction changes. */
  onChange: (next: { field: T; direction: "asc" | "desc" }) => void;
  /** Accessible group label; defaults to `uiLongTable.sort`. */
  label?: string;
}) {
  const groupLabel = label ?? t("uiLongTable.sort");
  const current = fields.find(entry => entry.id === field) ?? fields[0];
  const currentLabel = current?.label ?? field;
  const dirLabel = direction === "asc" ? t("uiLongTable.ascending") : t("uiLongTable.descending");
  const nextDirection = direction === "asc" ? "desc" : "asc";

  return (
    <div className={s.sort} role="group" aria-label={groupLabel} data-sort-control="">
      <bdi className={s.prefix}>{groupLabel}</bdi>
      {fields.length > 1 ? (
        <>
          <select
            className={s.fieldSelect}
            aria-label={groupLabel}
            value={field}
            onChange={event => onChange({ field: event.target.value as T, direction })}
          >
            {fields.map(entry => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <Button
            variant="ghost"
            size="sm"
            icon
            aria-label={`${currentLabel} · ${dirLabel}`}
            title={`${currentLabel} · ${dirLabel}`}
            onClick={() => onChange({ field, direction: nextDirection })}
          >
            {direction === "asc" ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />}
          </Button>
        </>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className={s.dirBtn}
          aria-label={`${groupLabel}: ${currentLabel} (${dirLabel})`}
          onClick={() => onChange({ field, direction: nextDirection })}
        >
          <bdi>{currentLabel}</bdi>
          {direction === "asc" ? <ArrowUp size={13} aria-hidden="true" /> : <ArrowDown size={13} aria-hidden="true" />}
        </Button>
      )}
    </div>
  );
}

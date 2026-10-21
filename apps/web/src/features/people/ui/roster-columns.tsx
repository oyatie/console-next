import { useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Columns3, Lock } from "lucide-react";
import { t } from "@console/i18n";
import { Button, Check } from "../../../ui/button/button";
import { ChipChoice } from "../../../ui/choice/chip-choice";
import { PopoverButton } from "../../../ui/popover/popover-button";
import { moveColumn, OPTIONAL_COLUMNS, toggleColumn, type ColumnId } from "../domain/columns";
import type { Density } from "./use-roster-columns";
import s from "./roster.module.css";

/**
 * The column chooser (E1-views): one list, shown columns first in their order, each with its box and its ↑↓ (and
 * Alt+↑↓ with a live sentence; never by dragging alone, WCAG 2.5.7); employee number and name are fixed first. Beside it the row height
 * and the way back to the default. Kept on this device; a named view waits for the view store.
 */
export function RosterColumns({ shown, onChange, density, onDensity }: { shown: ColumnId[]; onChange: (c: ColumnId[]) => void; density: Density; onDensity: (d: Density) => void }) {
  const [said, setSaid] = useState("");
  const name = (id: ColumnId) => t(`roster.columns.${id}`);
  const move = (id: ColumnId, by: -1 | 1) => {
    const next = moveColumn(shown, id, by);
    onChange(next);
    setSaid(t("roster.columns.moved", { column: name(id), place: next.indexOf(id) + 3 }));
  };
  const alt = (e: KeyboardEvent, id: ColumnId) => {
    if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown") || !shown.includes(id)) return;
    e.preventDefault();
    move(id, e.key === "ArrowUp" ? -1 : 1);
  };
  const rows = [...shown, ...OPTIONAL_COLUMNS.filter((id) => !shown.includes(id))];
  const count = shown.length + 2;
  return (
    <PopoverButton wide label={t("roster.columns.open", { count })} trigger={<><Columns3 size={14} aria-hidden /> {t("roster.columns.open", { count })}</>} title={t("roster.columns.title")}>
      {() => (
        <div className={s.columns}>
          <div className={s.colList}>
            <p className={s.said}>{t("roster.columns.head", { count })}</p>
            <ul className={s.order} aria-label={t("roster.columns.order")}>
              {(["number", "name"] as const).map((id) => (
                <li key={id} className={s.fixed}><Lock size={12} aria-hidden /><span>{t(`roster.columns.fixed.${id}`)}</span></li>
              ))}
              {rows.map((id) => {
                const on = shown.includes(id);
                const at = shown.indexOf(id);
                return (
                  <li key={id}>
                    <span className={s.colBox}><Check checked={on} onChange={() => onChange(toggleColumn(shown, id))}>{on ? t("roster.columns.nth", { place: at + 3, column: name(id) }) : name(id)}</Check></span>
                    {on && <Button variant="ghost" aria-label={t("roster.columns.up", { column: name(id) })} disabled={at === 0} onClick={() => move(id, -1)} onKeyDown={(e) => alt(e, id)}><ArrowUp size={14} aria-hidden /></Button>}
                    {on && <Button variant="ghost" aria-label={t("roster.columns.down", { column: name(id) })} disabled={at === shown.length - 1} onClick={() => move(id, 1)} onKeyDown={(e) => alt(e, id)}><ArrowDown size={14} aria-hidden /></Button>}
                  </li>
                );
              })}
            </ul>
            <p className={s.said} role="status">{said}</p>
          </div>
          <div className={s.colSide}>
            <ChipChoice label={t("roster.columns.density")} options={[{ value: "compact", label: t("roster.columns.compact") }, { value: "regular", label: t("roster.columns.regular") }]} value={density} onChange={(v) => onDensity(v as Density)} />
            <Button disabled={shown.join() === OPTIONAL_COLUMNS.join()} onClick={() => (onChange([...OPTIONAL_COLUMNS]), setSaid(t("roster.columns.reset.said")))}>{t("roster.columns.reset")}</Button>
          </div>
        </div>
      )}
    </PopoverButton>
  );
}

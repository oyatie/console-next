import { Check, Inbox, Layers } from "lucide-react";
import { t } from "@console/i18n";
import { ToggleButton } from "../../../ui/button/button";
import { Kbd } from "../../../ui/kbd/kbd";
import type { Group } from "../domain/unplaced";
import { sourceText } from "../present";
import s from "./unplaced.module.css";

export type DoneGroup = { value: string; count: number; place: string };

/**
 * The left pane (spec E8): the groups of one company by source value, the ones placed in this visit struck through at
 * the top, the current one pressed, each with its size and what is suggested for it; and the closing sum.
 */
export function UnplacedGroups({ groups, done, current, onPick, hint }: {
  groups: readonly Group[];
  done: readonly DoneGroup[];
  current: number;
  onPick: (i: number) => void;
  /** What each group's line says under its value (a suggestion's name, or none). */
  hint: (g: Group) => string;
}) {
  const sizes = [...done.map((d) => d.count), ...groups.map((g) => g.people.length)];
  const total = sizes.reduce((a, b) => a + b, 0);
  const placed = done.reduce((a, d) => a + d.count, 0);
  return (
    <aside className={s.groups} aria-label={t("unplaced.groups", { n: total })}>
      <div className={s.groupsHead}>
        <Layers size={14} aria-hidden />
        <span>{t("unplaced.groups", { n: total })}</span>
        <span className={s.grow} />
        <Kbd keys="J" />
        <Kbd keys="K" />
      </div>
      <ul className={s.groupList}>
        {done.map((d) => (
          <li key={`done-${d.value}`} className={s.groupDone}>
            <Check size={14} aria-hidden className={s.ok} />
            <span className={s.groupText}><s>{sourceText(d.value)}</s><small>{t("unplaced.groupDone", { place: d.place })}</small></span>
            <b className="num">{d.count}</b>
          </li>
        ))}
        {groups.map((g, i) => (
          <li key={g.value || "none"}>
            <ToggleButton pressed={i === current} className={s.groupPick} onClick={() => onPick(i)}>
              <Inbox size={14} aria-hidden />
              <span className={s.groupText}><span>{sourceText(g.value)}</span><small>{hint(g)}</small></span>
              <b className="num">{g.people.length}</b>
            </ToggleButton>
          </li>
        ))}
      </ul>
      <p className={s.groupsFoot}>{t("unplaced.total", { parts: sizes.join(" + "), n: total, done: placed, left: total - placed })}</p>
    </aside>
  );
}

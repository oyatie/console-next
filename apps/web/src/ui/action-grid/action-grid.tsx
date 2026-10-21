import { useEffect, useRef, type ReactNode } from "react";
import { Ban } from "lucide-react";
import { Kbd } from "../kbd/kbd";
import s from "./action-grid.module.css";

/** One act: `keys` is its letter (typed while the grid is open); `disabled` is why it cannot be done now. */
export type ActionItem = { id: string; icon: ReactNode; title: string; desc: string; keys?: string; disabled?: string };
export type ActionGroup = { title: string; items: readonly ActionItem[] };

/**
 * A grid of acts in groups (spec E5-menu): each with its icon, a short description and its letter key; an act that
 * cannot be done now stays listed, dimmed, with why. Opens anchored under its trigger (top right of the record),
 * focuses the first available act, picks by click, Enter or the letter, and closes on Esc or a click outside.
 */
export function ActionGrid({ label, head, groups, tail, foot, onPick, onClose }: {
  label: string;
  head: ReactNode;
  groups: readonly ActionGroup[];
  /** A full-width row under the groups (e.g. an act offered elsewhere, with why). */
  tail?: ActionItem;
  foot?: ReactNode;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const all = [...groups.flatMap((g) => g.items), ...(tail ? [tail] : [])];
  const latest = useRef({ all, onPick, onClose });
  useEffect(() => void (latest.current = { all, onPick, onClose }));
  useEffect(() => {
    box.current?.querySelector<HTMLElement>("button:not([aria-disabled])")?.focus();
    const key = (e: KeyboardEvent) => {
      const { all: items, onPick: pick, onClose: close } = latest.current;
      if (e.key === "Escape") return close();
      if (e.altKey || e.ctrlKey || e.isComposing) return;
      const chord = e.metaKey ? `⌘${e.key.toUpperCase()}` : e.key.toUpperCase();
      const hit = items.find((i) => i.keys === chord && !i.disabled);
      if (!hit) return;
      e.preventDefault();
      pick(hit.id);
    };
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && latest.current.onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", away);
    return () => (window.removeEventListener("keydown", key), window.removeEventListener("pointerdown", away));
  }, []);
  const row = (i: ActionItem) => (
    <button key={i.id} type="button" className={s.item} aria-disabled={i.disabled ? true : undefined} aria-describedby={`${i.id}-d`} onClick={() => !i.disabled && onPick(i.id)}>
      <span className={s.icon} aria-hidden>{i.disabled ? <Ban size={14} /> : i.icon}</span>
      <span className={s.title}>{i.title}</span>
      <small id={`${i.id}-d`} className={s.desc}>{i.disabled ?? i.desc}</small>
      {i.keys && !i.disabled && <Kbd keys={i.keys} />}
    </button>
  );
  return (
    <div ref={box} className={s.grid} role="dialog" aria-label={label}>
      <div className={s.head}>{head}</div>
      <div className={s.groups}>
        {groups.map((g) => (
          <section key={g.title} className={s.group} aria-label={g.title}>
            <h3 className={s.groupTitle}>{g.title}</h3>
            {g.items.map(row)}
          </section>
        ))}
      </div>
      {tail && <div className={s.tail}>{row(tail)}</div>}
      {foot != null && <div className={s.foot}>{foot}</div>}
    </div>
  );
}

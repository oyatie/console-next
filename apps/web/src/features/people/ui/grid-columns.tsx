import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Columns3, Lock, Search } from "lucide-react";
import { t } from "@console/i18n";
import { Checks } from "../../../ui/choice/checks";
import { TextInput } from "../../../ui/field/field";
import { Kbd } from "../../../ui/kbd/kbd";
import { GRID_FIELDS, type GridKey } from "../domain/grid";
import s from "./grid-columns.module.css";

/** The card's sections, each with the fields this grid edits and the ones changed elsewhere (spec E6-columns). */
const GROUPS = [
  { key: "person", edit: ["name", "sex", "birth_date", "address", "work_email", "employee_number"], routed: [["rrn", "card"]] },
  { key: "work", edit: ["job", "hire_date", "employment_type", "register_note"], routed: [["org_unit", "act"], ["worksite_name", "act"], ["company", "act"]] },
  { key: "history", edit: [], routed: [["careers", "import"], ["restricted", "none"]] },
] as const satisfies readonly { key: string; edit: readonly GridKey[]; routed: readonly (readonly [string, "act" | "card" | "import" | "none"])[] }[];
const LINK = { act: "/people/bulk", import: "/people/import" } as const;

/**
 * Choose columns (spec E6-columns): every card field by section, found by name. A field this grid edits is a box (its
 * tag says whether a second person confirms); a field changed elsewhere says where, with the way there. Picks apply at
 * once; Esc or a click outside closes. At least one column stays.
 */
export function GridColumns({ value, onChange, onClose }: { value: readonly GridKey[]; onChange: (cols: GridKey[]) => void; onClose: () => void }) {
  const [find, setFind] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    search.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const out = (e: PointerEvent) => !box.current?.contains(e.target as Node) && onClose();
    window.addEventListener("keydown", key);
    window.addEventListener("pointerdown", out);
    return () => (window.removeEventListener("keydown", key), window.removeEventListener("pointerdown", out));
  }, [onClose]);
  const hit = (label: string) => !find.trim() || label.includes(find.trim());
  const set = (group: readonly GridKey[], picked: string[]) => {
    const next = GRID_FIELDS.map((f) => f.key).filter((k) => (group.includes(k) ? picked.includes(k) : value.includes(k)));
    if (next.length) onChange(next);
  };
  return (
    <div ref={box} className={s.pop} role="dialog" aria-label={t("bulkGrid.pick.title")}>
      <div className={s.head}>
        <Columns3 size={14} aria-hidden />
        <span>{t("bulkGrid.pick.title")}</span>
        <span className={s.grow} />
        <span className={s.find}>
          <Search size={14} aria-hidden />
          <TextInput ref={search} aria-label={t("bulkGrid.pick.find")} placeholder={t("bulkGrid.pick.find")} value={find} onChange={(e) => setFind(e.target.value)} />
        </span>
      </div>
      <div className={s.cols}>
        {GROUPS.map((g) => {
          const edit = g.edit.filter((k) => hit(t(`bulkGrid.field.${k}`)));
          const routed = g.routed.filter(([k]) => hit(t(`bulkGrid.routed.${k}`)));
          return (
            <section key={g.key} className={s.group} aria-label={t(`bulkGrid.pick.group.${g.key}`)}>
              {edit.length > 0 ? (
                <Checks
                  label={t(`bulkGrid.pick.group.${g.key}`)}
                  required={false}
                  items={edit.map((k) => {
                    const f = GRID_FIELDS.find((x) => x.key === k)!;
                    return { id: k, label: <span className={s.item}>{t(`bulkGrid.field.${k}`)}<span className={s.tag} data-cls={f.cls}>{t(`bulkGrid.tag.${f.cls}`)}</span></span> };
                  })}
                  value={value.filter((k) => (edit as readonly string[]).includes(k))}
                  onChange={(v) => set(edit, v)}
                />
              ) : (
                <h3 className={s.groupTitle}>{t(`bulkGrid.pick.group.${g.key}`)}</h3>
              )}
              <ul className={s.routed}>
                {routed.map(([k, where]) => (
                  <li key={k}>
                    <span>{t(`bulkGrid.routed.${k}`)}</span>
                    {where === "act" || where === "import" ? (
                      <Link to={LINK[where]}>{t(`bulkGrid.pick.${where}`)}</Link>
                    ) : (
                      <span className={s.lock}><Lock size={12} aria-hidden />{t(`bulkGrid.pick.${where}`)}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <div className={s.foot}>
        <span>{t("bulkGrid.pick.picked", { n: value.length, names: value.map((k) => t(`bulkGrid.field.${k}`)).join(" · ") })}</span>
        <span className={s.grow} />
        <span>{t("bulkGrid.pick.secondNote")}</span>
        <Kbd keys="Esc" />
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { t } from "@console/i18n";
import type { Tag, View } from "../domain/structure-plans";
import s from "./mini-tree.module.css";

const TONE: Record<Tag, "gone" | "mov" | "chg" | "new"> = { gone: "gone", raised: "mov", movedIn: "mov", carried: "mov", merged: "chg", renamed: "chg", movedRenamed: "mov", new: "new" };

/** A changed box's tag as text (D16): colour is only the second cue. */
const tagText = (v: View) => (v.tag === "merged" ? t("orgStructure.tag.merged", { n: v.extra ?? 0 }) : t(`orgStructure.tag.${v.tag!}`));

/**
 * A small before/after tree for a structure change (S6-delete, S6-merge, S8): the root (a workplace) with its department nested
 * under connectors, each changed box carrying its tag. `empty` stands in until the choices that shape it are made.
 */
export function MiniTree({ label, root, empty }: { label: string; root?: View; empty?: ReactNode }) {
  return (
    <figure className={s.frame} aria-label={label}>
      <figcaption className={s.cap}>{label}</figcaption>
      {root ? <ul className={s.tree}><Box v={root} top /></ul> : <div className={s.empty}>{empty}</div>}
    </figure>
  );
}

function Box({ v, top }: { v: View; top?: boolean }) {
  return (
    <li className={s.item}>
      <div className={s.box} data-top={top || undefined} data-tone={v.tag ? TONE[v.tag] : undefined}>
        <span className={s.name}>{v.name}</span>
        <span className={s.n}>{v.n}</span>
        {v.tag && <span className={s.tag} data-tone={TONE[v.tag]}>{tagText(v)}</span>}
      </div>
      {v.children.length > 0 && <ul className={s.kids}>{v.children.map((c) => <Box key={c.id} v={c} />)}</ul>}
    </li>
  );
}

/** The legend for the tags a picture uses. */
export function TreeLegend({ tags }: { tags: readonly Tag[] }) {
  return (
    <ul className={s.legend}>
      {tags.map((g) => (
        <li key={g}><i data-tone={TONE[g]} aria-hidden />{t(`orgStructure.legend.${g}`)}</li>
      ))}
    </ul>
  );
}

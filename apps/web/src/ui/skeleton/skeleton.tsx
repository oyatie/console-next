import s from "./skeleton.module.css";

/** One placeholder's shape: a title, a text line, a full-width row; on a record screen also a crumb, a short line, a
 * section block and the history column. */
export type Bone = "title" | "line" | "row" | "crumb" | "short" | "block" | "spine";

/**
 * The loading shape of a view (design-language §5.2): neutral blocks in the final layout's dimensions, shown only
 * after 200 ms (no flash for a fast load), no shimmer, no spinner. Busy for assistive tech; the words come from
 * the region that holds it.
 */
export function Skeleton({ bones, label }: { bones: readonly Bone[]; label: string }) {
  return (
    <div className={s.skeleton} role="status" aria-busy="true" aria-label={label}>
      {bones.map((b, i) => <span key={i} className={s.bone} data-bone={b} />)}
    </div>
  );
}

/** One placeholder in a caller's own layout (a record head drawn in outline): the caller delays the whole shape. */
export function BoneShape({ bone }: { bone: Bone }) {
  return <span className={s.bone} data-bone={bone} />;
}

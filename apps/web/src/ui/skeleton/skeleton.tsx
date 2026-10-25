import s from "./skeleton.module.css";
import { t } from "@console/i18n";

/** One placeholder's shape: a title, a text line, a full-width row; on a record screen also a crumb, a short line, a
 * section block and the history column. */
export type Bone = "title" | "line" | "row" | "crumb" | "short" | "block" | "spine";

/**
 * The loading shape of a view (design-language §5.2): neutral blocks in the final layout's dimensions, shown only
 * after 200 ms (no flash for a fast load), no shimmer, no spinner. Busy for assistive tech; the words come from
 * the region that holds it.
 */
export function Skeleton({ bones, label, decorative = false }: { bones: readonly Bone[]; label?: string; decorative?: boolean }) {
  return (
    <div className={s.skeleton} role={decorative ? undefined : "status"} aria-busy={decorative ? undefined : true} aria-label={decorative ? undefined : label} aria-hidden={decorative || undefined}>
      {bones.map((b, i) => <span key={i} className={s.bone} data-bone={b} />)}
    </div>
  );
}

/** One placeholder in a caller's own layout (a record head drawn in outline): the caller delays the whole shape. */
export function BoneShape({ bone }: { bone: Bone }) {
  return <span className={s.bone} data-bone={bone} />;
}

export type ReadLayout = "list" | "record" | "form" | "grid";

/** Page containers retain their shape while required reads are pending. */
export function ReadSkeleton({ layout = "list" }: { layout?: ReadLayout }) {
  const label = t("common.loading");
  return <div className="page" data-read-layout={layout} role="status" aria-busy="true" aria-label={label}>
    <Skeleton decorative bones={["crumb", "title", "line"]} />
    {layout === "record" ? <div className="split" data-open="true">
      <Skeleton decorative bones={["block", "block"]} />
      <Skeleton decorative bones={["spine"]} />
    </div> : <Skeleton decorative bones={layout === "form" ? ["block", "block"] : layout === "grid" ? ["spine"] : ["row", "row", "row", "row", "row", "row"]} />}
  </div>;
}

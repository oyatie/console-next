// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import css from "./long-table.module.css";

export const Box = () => <span className={css.box} aria-hidden="true" />;

/**
 * The first page's placeholder: the table's columns and rows as grey bars, announced once as loading. CSS shows
 * the bars only after `display.skeleton_delay` (200 ms, the animation delay), so a fast load never flashes.
 */
export function Skeleton({ columns, rows }: { columns: number; rows: number }) {
  return (
    <div className={css.skeleton} role="status">
      <span className="sr-only">{t("uiLongTable.loading")}</span>
      {Array.from({ length: rows }, (_r, i) => (
        <div key={i} className={css.skeletonRow} aria-hidden="true">
          {Array.from({ length: columns }, (_c, j) => <span key={j} className={css.skeletonCell} />)}
        </div>
      ))}
    </div>
  );
}

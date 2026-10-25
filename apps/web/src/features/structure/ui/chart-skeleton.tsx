import { t } from "@console/i18n";
import css from "./chart.module.css";

/** Loading (spec S1-loading): the canvas keeps its place, so nothing around it moves when the chart arrives. */
export function ChartSkeleton() {
  return (
    <div className={css.skeleton} data-read-layout="grid" aria-busy="true">
      <p className="muted" role="status">{t("structure.loading")}</p>
    </div>
  );
}

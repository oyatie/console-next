import { ArrowRight } from "lucide-react";
import { t } from "@console/i18n";
import type { Tag, View } from "../domain/structure-plans";
import { MiniTree, TreeLegend } from "./mini-tree";
import s from "./mini-tree.module.css";
import css from "../../../reference/org/ui/structure.module.css";

/** What changes: now → after, side by side with the tags' legend; the after side waits for its answers. */
export function DiffPair({ before, after, afterLabel, legend, pending }: { before: View; after?: View; afterLabel: string; legend: readonly Tag[]; pending: string }) {
  return (
    <section className={css.stack} aria-labelledby="diff-pair-h">
      <div className="row">
        <h3 id="diff-pair-h" className="field__label grow">{t("orgStructure.diff.title")}</h3>
        <TreeLegend tags={legend} />
      </div>
      <div className={s.pair}>
        <MiniTree label={t("orgStructure.diff.now")} root={before} />
        <ArrowRight size={20} aria-hidden className={s.arrow} />
        <MiniTree label={afterLabel} root={after} empty={pending} />
      </div>
    </section>
  );
}

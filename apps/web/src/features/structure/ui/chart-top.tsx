import { ChevronRight, Maximize2, Search } from "lucide-react";
import { t } from "@console/i18n";
import { Button, ToggleButton } from "../../../ui/button/button";
import { TextInput } from "../../../ui/field/field";
import type { Depth } from "../domain/layout";
import { pathTo, type ChartNode, type Structure } from "../domain/model";
import type { ChartState } from "./use-chart-state";
import css from "./chart.module.css";

const DEPTHS: Depth[] = ["sites", "one", "all"];
/** The root's crumb is "All", never the account's name (decision #29). */
const crumb = (n: ChartNode) => (n.kind === "tenant" ? t("structure.root.word") : n.name);

/** The canvas's top edge: crumbs to the focus, find (/), and the depth control. */
export function ChartTop({ s, c, onFocus, onFind }: { s: Structure; c: ChartState; onFocus: (id: string | undefined) => void; onFind: (id: string) => void }) {
  const current = c.hits.ids[c.hit];
  // While finding, the crumbs follow the result shown (S2-chart-scale-search); a crumb still focuses its unit.
  const path = pathTo(s, c.q.trim() && current ? current : c.focus.id);
  const step = (d: number) => {
    if (!c.hits.ids.length) return;
    c.stepHit(d);
    onFind(c.hits.ids[(c.hit + d + c.hits.ids.length) % c.hits.ids.length]!);
  };
  return (
    <>
      <nav className={`${css.crumbs} card`} aria-label={t("structure.crumbs")}>
        {path.map((n, i) => (
          <span key={n.id} className={css.crumb}>
            {i > 0 && <ChevronRight size={14} aria-hidden />}
            {i === path.length - 1 ? <span aria-current="location">{crumb(n)}</span> : <Button variant="ghost" onClick={() => onFocus(n.kind === "tenant" ? undefined : n.id)}>{crumb(n)}</Button>}
          </span>
        ))}
      </nav>
      {c.focus.kind !== "tenant" && (
        <Button variant="ghost" className={`${css.floatBtn} card`} onClick={() => onFocus(undefined)}><Maximize2 size={16} aria-hidden />{t("structure.top.all")}</Button>
      )}
      <span className="grow" />
      <div className={css.findWrap}>
        <label className={`${css.find} card`} htmlFor="structure-find">
          <Search size={16} aria-hidden />
          <TextInput
            id="structure-find"
            type="search"
            className={css.findInput}
            aria-label={t("structure.find.label")}
            placeholder={t("structure.find.placeholder")}
            value={c.q}
            onChange={(e) => c.search(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              const d = { Enter: 0, ArrowDown: 1, ArrowUp: -1 }[e.key];
              if (d !== undefined) {
                e.preventDefault();
                step(d);
              }
              if (e.key === "Escape") c.search("");
            }}
          />
          {c.q.trim() !== "" && c.hits.ids.length > 0 && <span className={css.findAt}>{t("structureChart.find.at", { at: c.hit + 1, total: c.hits.ids.length })}</span>}
          <kbd className={css.kbd}>/</kbd>
        </label>
      </div>
      <div className={`${css.seg} card`} role="group" aria-label={t("structure.depth.label")}>
        {DEPTHS.map((d) => <ToggleButton key={d} pressed={c.depth === d} onClick={() => c.setDepth(d)}>{t(`structure.depth.${d}`)}</ToggleButton>)}
      </div>
    </>
  );
}

/**
 * Where a find stands, docked in the gutter so it never covers the chart (S2-chart-scale-search): the result shown
 * of how many, the count per legal entity and the keys, or that nothing matches.
 */
export function FindStatus({ s, c }: { s: Structure; c: ChartState }) {
  return (
    <p className={`${css.hint} ${css.findStatus} card`} role="status">
      {c.hits.ids.length === 0 ? (
        t("structure.find.none", { q: c.q.trim() })
      ) : (
        <>
          <strong>{t("structure.find.position", { at: c.hit + 1, total: c.hits.ids.length })}</strong>
          <span className={css.findPer}>
            {[...c.hits.perEntity].map(([id, n]) => <span key={id}>{t("structure.find.perEntity", { name: s.byId.get(id)?.name ?? "", count: n })}</span>)}
          </span>
          <span>{t("structure.find.keys")}</span>
        </>
      )}
    </p>
  );
}

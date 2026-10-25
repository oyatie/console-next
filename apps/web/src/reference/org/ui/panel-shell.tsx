import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronRight, Maximize2, X } from "lucide-react";
import { t } from "@console/i18n";
import { focusSoon } from "../../../lib/react/announce";
import { Button } from "../../../ui/button/button";
import css from "./structure.module.css";

/**
 * The side panel's anatomy (S5-panel, S6-panel): a crumb, the title with its chips, in-panel anchors, then the body.
 * It sits beside the chart (the chart stays live); Esc and ✕ close it and return focus to the chart.
 */
export function PanelShell({ crumb, icon, title, chips, anchors, open, children, onClose }: {
  crumb: readonly string[];
  icon: ReactNode;
  title: string;
  chips?: ReactNode;
  anchors: readonly { id: string; label: string }[];
  /** The full record, when it has its own page. */
  open?: ReactNode;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = () => {
    onClose();
    focusSoon("org-tree");
  };
  // Esc inside the panel (not already taken by a popover) closes it.
  useEffect(() => {
    const el = ref.current;
    const key = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && close();
    el?.addEventListener("keydown", key);
    return () => el?.removeEventListener("keydown", key);
  });
  const id = useId();
  return (
    <aside ref={ref} className={css.panel} aria-labelledby={`${id}-title`}>
      <div className={css.panelHead}>
        <nav className={css.crumb} aria-label={t("orgStructure.panel.where")}>
          {crumb.map((c, i) => (
            <span key={`${i}-${c}`} className={css.crumb}>
              {i > 0 && <ChevronRight size={12} aria-hidden />}
              {i === crumb.length - 1 ? <b>{c}</b> : c}
            </span>
          ))}
        </nav>
        <div className={css.title}>
          {icon}
          <h2 id={`${id}-title`} tabIndex={-1}>{title}</h2>
          {chips}
          <span className="grow" />
          {open}
          <Button variant="ghost" onClick={close} aria-label={t("common.closePanel")}><X size={16} aria-hidden /></Button>
        </div>
        <nav className={css.tabs} aria-label={t("orgStructure.panel.sections")}>
          {anchors.map((a) => <Button key={a.id} variant="ghost" className="btn--sm" onClick={() => document.getElementById(a.id)?.scrollIntoView({ block: "start" })}>{a.label}</Button>)}
        </nav>
      </div>
      <div className={css.panelBody}>{children}</div>
    </aside>
  );
}

/** The panel's open-in-full control (an icon link to the record's page). */
export const FullIcon = () => <Maximize2 size={16} aria-hidden />;

/** A headed section an anchor jumps to. `more` sits at the right of the heading (e.g. the full list link). */
export function Sec({ id, title, more, children }: { id: string; title: string; more?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} className={css.sec} aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`} className={css.secH} tabIndex={-1}>{title}{more}</h3>
      {children}
    </section>
  );
}

/** The KPI row: label under the number, the number first in reading order for screen readers. */
export function Stats({ items }: { items: readonly { label: string; value: ReactNode; name?: boolean }[] }) {
  return (
    <dl className={css.stats}>
      {items.map((s) => (
        <div key={s.label}>
          <dd className={s.name ? css.name : "num"}>{s.value}</dd>
          <dt>{s.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** A fact row: its label, its value, and the verb that changes it (change · change) or the correct-only mark. */
export type Fact = { label: string; value: ReactNode; act?: ReactNode };
export function Facts({ rows }: { rows: readonly (Fact | false | undefined)[] }) {
  return (
    <dl className={css.kv}>
      {rows.filter((r): r is Fact => Boolean(r)).map((r) => (
        <div key={r.label} className={css.kvRow}>
          <dt>{r.label}</dt>
          <dd>{r.value}</dd>
          <dd className={css.act}>{r.act}</dd>
        </div>
      ))}
    </dl>
  );
}

/** One row of actions: the action, and what it does to whom (its consequence) beside it. */
export function ActionRow({ control, why }: { control: (describedBy: string) => ReactNode; why: ReactNode }) {
  const id = useId();
  return (
    <div>
      {control(id)}
      <span id={id} className={css.why}>{why}</span>
    </div>
  );
}
export const Actions = ({ children }: { children: ReactNode }) => <div role="group" className={css.acts}>{children}</div>;

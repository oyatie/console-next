import { useEffect, useId, useRef, type ReactNode } from "react";
import { AlertTriangle, Ban, CheckCircle2, Circle } from "lucide-react";
import { t } from "@console/i18n";
import s from "./setup-rail.module.css";

export type SetupState = "todo" | "done" | "attention" | "blocked";
/**
 * One setup step. `action` is its one primary action (shown while not done). A blocked step must say
 * what blocks it (`detail`) and carry `remedy`, the action that clears it: a step is never greyed out
 * without its fix. `attention` is done with something still to look at (`detail` says what).
 */
export type SetupStepView = {
  key: string;
  title: ReactNode;
  collapsed?: boolean;
  locked?: boolean;
  blocker?: ReactNode;
  state: SetupState;
  detail?: ReactNode;
  owner?: ReactNode;
  action?: ReactNode;
  remedy?: ReactNode;
  /** A secondary action, e.g. "later" for an optional step or an import alternative. */
  secondary?: ReactNode;
};
export type SetupGroup = { key: string; title: string; steps: readonly SetupStepView[] };

const ICON = { todo: Circle, done: CheckCircle2, attention: AlertTriangle, blocked: Ban } as const;
const TONE = { todo: "neutral", done: "ok", attention: "warn", blocked: "neutral" } as const;

// eslint-disable-next-line react/only-export-components -- Home and the rail share this current-step rule.
export const currentStep = (steps: readonly Pick<SetupStepView, "key" | "state">[]) =>
  steps.find((x) => x.state !== "done" && x.state !== "attention")?.key;

/**
 * A guided first-run checklist (design §6.2): steps grouped into phases, each with a state, one primary
 * action and, when blocked, its remedy. The first step not done is the current one (aria-current). J and K
 * move between steps. The rail renders what the caller computed; it decides nothing.
 */
export function SetupRail({ title, summary, groups }: { title: string; summary?: ReactNode; groups: readonly SetupGroup[] }) {
  const id = useId();
  const all = groups.flatMap((g) => g.steps);
  const current = currentStep(all);
  const done = all.filter((x) => x.state === "done" || x.state === "attention").length;
  const progress = t("uiSetupRail.progress", { done, total: all.length });
  const box = useRef<HTMLDivElement>(null);
  // J/K is a convenience on top of Tab (the list stays a list for assistive tech), so it is a plain listener.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const move = (e: KeyboardEvent) => {
      if ((e.key !== "j" && e.key !== "k") || e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]")) return;
      const items = [...el.querySelectorAll<HTMLElement>("[data-step]")];
      const at = items.findIndex((x) => x.contains(document.activeElement));
      const next = items[Math.min(items.length - 1, Math.max(0, at + (e.key === "j" ? 1 : -1)))];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    };
    el.addEventListener("keydown", move);
    return () => el.removeEventListener("keydown", move);
  }, []);
  return (
    <section className={`card ${s.rail}`} aria-labelledby={id}>
      <div className={s.head}>
        <h2 id={id} className="panel__title">{title}</h2>
        <span className={s.count} role="progressbar" aria-labelledby={id} aria-valuemin={0} aria-valuenow={done} aria-valuemax={all.length} aria-valuetext={progress}>{progress}</span>
      </div>
      {summary != null && <p className={s.summary}>{summary}</p>}
      <div ref={box} className={s.groups}>
        {groups.map((g) => (
          <div key={`${g.key}-${g.steps[0]?.key ?? "empty"}`} className={s.group}>
            {groups.length > 1 && <h3 className={s.groupTitle}>{g.title}</h3>}
            <ol className={s.steps}>
              {g.steps.map((x) => {
                const Icon = ICON[x.state];
                return (
                  <li key={x.key} className={s.step} data-state={x.state} data-step tabIndex={-1} aria-current={x.key === current ? "step" : undefined}>
                    <Icon size={18} className={s.icon} aria-hidden />
                    <span className={s.title}>{x.title}</span>
                    <span className={`chip chip--${TONE[x.state]} ${s.badge}`} data-step-state={x.state}>{t(`uiSetupRail.state.${x.state}`)}</span>
                    <span className={s.actions}>
                      {!x.collapsed && (x.state === "blocked" ? x.blocker != null ? x.action : x.remedy : x.state !== "done" && x.action)}
                      {!x.collapsed && x.state !== "done" && x.secondary}
                    </span>
                    {(!x.collapsed || x.state === "blocked" || x.state === "attention" || x.locked) && <div className={s.foot}>
                      <div className={s.detail}><span>{(!x.collapsed || (!x.locked && x.state === "attention")) && x.detail}</span>{x.state === "blocked" && (!x.collapsed || !x.locked) && x.blocker != null && <>{x.blocker}{x.remedy}</>}</div>
                      {(!x.collapsed || x.locked) && x.owner != null && <small className={s.owner} data-step-owner>{x.owner}</small>}
                    </div>}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}

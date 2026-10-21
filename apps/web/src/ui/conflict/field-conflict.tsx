import type { ReactNode } from "react";
import { Radio, RadioGroup } from "react-aria-components";
import { t } from "@console/i18n";
import s from "./conflict.module.css";

/** ME-2: "theirs" takes the current server value, "mine" keeps the input (lib/pure/three-way Choice). */
export type ConflictChoice = "theirs" | "mine";

/** One `errors[]` entry of a 409 field_conflict / stale_facts, rendered by the caller. */
export type Conflict = {
  /** The entry's `pointer`, as a key. */
  field: string;
  label: string;
  mine: ReactNode;
  current: ReactNode;
  /** The value as loaded, when the caller still has it. */
  base?: ReactNode;
  /** Absent when the actor is covert-labelled: never named (OD-RT-3). */
  actor?: string;
  /** Preformatted time of the change. */
  at: string;
};

const shown = (v: ReactNode) => (v == null || v === "" ? <span className={s.empty}>{t("uiConflict.empty")}</span> : v);

/**
 * The 409 conflict view (design/concurrent-editing.md ME-2, ME-5, ME-7): for every changed field, mine
 * beside current and who changed it when, with an explicit use-theirs / keep-mine choice and nothing
 * preselected. The user's input is never dropped. The caller keeps the choices (lib/pure/three-way
 * `resolve`) and keeps submit blocked until `choices` has one for every field (`hasConflict`).
 */
export function ConflictPanel({ kind, conflicts, choices, onChoose }: {
  kind: "field_conflict" | "stale_facts";
  conflicts: readonly Conflict[];
  choices: Readonly<Record<string, ConflictChoice | undefined>>;
  onChoose: (field: string, choice: ConflictChoice) => void;
}) {
  const left = conflicts.filter((c) => !choices[c.field]).length;
  return (
    <section className={s.panel}>
      <div className={s.head} role="alert">
        <p className={s.lead}>{t(`uiConflict.${kind}`, { count: conflicts.length })}</p>
      </div>
      <p className={s.progress} role="status">{left ? t("uiConflict.left", { count: left }) : t("uiConflict.done")}</p>
      <ul className={s.list}>
        {conflicts.map((c) => (
          <li key={c.field} className={s.item}>
            <p className={s.label}>{c.label}</p>
            <dl className={s.values}>
              {c.base != null && (
                <div className={s.base}>
                  <dt>{t("uiConflict.base")}</dt>
                  <dd>{shown(c.base)}</dd>
                </div>
              )}
              <div>
                <dt>{t("uiConflict.mine")}</dt>
                <dd>{shown(c.mine)}</dd>
              </div>
              <div>
                <dt>{t("uiConflict.current")}</dt>
                <dd>
                  {shown(c.current)}
                  <span className={s.by}>{c.actor ? t("uiConflict.changedBy", { actor: c.actor, at: c.at }) : t("uiConflict.changedBy.hidden", { at: c.at })}</span>
                </dd>
              </div>
            </dl>
            <RadioGroup
              className={s.choices}
              aria-label={t("uiConflict.choice", { label: c.label })}
              value={choices[c.field] ?? null}
              onChange={(v) => onChoose(c.field, v as ConflictChoice)}
              isRequired
              validationBehavior="aria"
              orientation="horizontal"
            >
              <Radio value="theirs" className={s.choice}>{t("uiConflict.useTheirs")}</Radio>
              <Radio value="mine" className={s.choice}>{t("uiConflict.keepMine")}</Radio>
            </RadioGroup>
          </li>
        ))}
      </ul>
    </section>
  );
}

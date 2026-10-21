import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Card } from "../../../ui/card/card";
import s from "./register-run.module.css";

/**
 * The run's side (spec E3-run): this run's counts and how it is undone (row by row, or all at once in the setup phase),
 * the keys, and what the run leaves as to-dos on each record card.
 */
export function RunSide({ registered, errors, dups, setup, undoing, onUndoAll }: {
  registered: number;
  errors: number;
  dups: number;
  setup: boolean;
  undoing: boolean;
  onUndoAll: () => void;
}) {
  return (
    <aside className={s.side} aria-label={t("register.run.batchTitle")}>
      <Card titleId="run-batch" title={t("register.run.batchTitle")}>
        <div className={s.chips}>
          <Chip tone="ok">{t("register.run.batchOk", { n: registered })}</Chip>
          <Chip tone={errors ? "danger" : "neutral"}>{t("register.run.batchErr", { n: errors })}</Chip>
          {dups > 0 && <Chip tone="warn">{t("register.run.batchDup", { n: dups })}</Chip>}
        </div>
        {registered > 0 && <p className={s.note}>{t(setup ? "register.run.batchSetup" : "register.run.batchOp")}</p>}
        {setup && registered > 1 && (
          <Button variant="ghost" aria-disabled={undoing || undefined} onClick={() => !undoing && onUndoAll()}>{t("register.run.undoAll", { n: registered })}</Button>
        )}
      </Card>
    </aside>
  );
}

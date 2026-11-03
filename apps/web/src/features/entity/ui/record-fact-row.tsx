import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { useRecordLock } from "./use-record-lock";
import s from "./record.module.css";

/** What a recorded fact offers: a first entry, normal edit, governed correction, or nothing. */
export type FactAction = { verb: "enter" | "edit" | "correct"; onPress: () => void } | null;

/**
 * One fact as the certificate prints it: its item number (when the certificate numbers it), name, value, and the
 * one verb it takes. Every verb's accessible name says which fact it acts on (R28).
 */
export function FactRow({ no, label, children, action: offered, wide }: { no?: number; label: string; children: ReactNode; action?: FactAction; wide?: boolean }) {
  // A closed record, or one the reader may not manage, shows its facts with no verb (company-03, worst-case-08).
  const lock = useRecordLock();
  const loading = lock === "loading";
  const action = lock && !loading ? null : offered;
  const verb = action && t(action.verb === "enter" ? "composer.verb.enter" : action.verb === "correct" ? "uiRecordVerbs.verb.correct" : "uiRecordActions.edit");
  return (
    <div className={s.fact} data-wide={wide || undefined}>
      <span className={s.no} aria-hidden>{no ?? ""}</span>
      <span className={s.factLabel}>{label}</span>
      <span className={s.factValue}>{children}</span>
      <span className={s.factAction} data-loading={loading || undefined} aria-hidden={loading || undefined} inert={loading || undefined}>
        {action && <Button variant="ghost" className={s.fix} aria-label={t("uiRecordActions.of", { field: label, verb })} onClick={action.onPress}>{verb}</Button>}
      </span>
    </div>
  );
}

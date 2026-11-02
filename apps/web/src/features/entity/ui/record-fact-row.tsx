import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { useRecordLock } from "./use-record-lock";
import s from "./record.module.css";

/** What a recorded fact offers: edit (change (REV) or correction (COR)), correct-only (a correction only), an identifier's lock, or nothing. */
export type FactAction = { kind: "fix" | "cor" | "lock"; onPress: () => void } | null;

/**
 * One fact as the certificate prints it: its item number (when the certificate numbers it), name, value, and the
 * one verb it takes. Every verb's accessible name says which fact it acts on (R28).
 */
export function FactRow({ no, label, children, action: offered, wide }: { no?: number; label: string; children: ReactNode; action?: FactAction; wide?: boolean }) {
  // A closed record, or one the reader may not manage, shows its facts with no verb (company-03, worst-case-08).
  const lock = useRecordLock();
  const loading = lock === "loading";
  const action = lock && !loading ? null : offered;
  return (
    <div className={s.fact} data-wide={wide || undefined}>
      <span className={s.no} aria-hidden>{no ?? ""}</span>
      <span className={s.factLabel}>{label}</span>
      <span className={s.factValue}>{children}</span>
      <span className={s.factAction} data-loading={loading || undefined} aria-hidden={loading || undefined} inert={loading || undefined}>
        {action && <Button variant="ghost" className={s.fix} aria-label={t("entityRecord.action.fixOf", { field: label })} onClick={action.onPress}>{t("entityRecord.action.fix")}</Button>}
      </span>
    </div>
  );
}

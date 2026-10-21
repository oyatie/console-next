import { useState } from "react";
import { Lock } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { CloseCorrectSheet } from "./record-close-correct";
import type { RecordLock } from "./use-record-lock";

/**
 * The read-only record says why, and what can still be done: a closed record's only verb is correcting the close itself
 * (catalog company-19); a record the reader may not manage names who grants that.
 */
export function LockNotice({ e, lock }: { e: LegalEntity; lock: RecordLock }) {
  const [correcting, setCorrecting] = useState(false);
  if (!lock || lock === "asof") return null;
  const reason = e.close_reason_code ? t(e.close_reason_code === "DISSOLVED" ? "entityRecordClose.dissolved" : "entityRecordClose.businessClosed") : "";
  return (
    <div className="notice row" role="note" data-lock={lock}>
      <Lock size={16} aria-hidden />
      <span className="grow">{lock === "closed" ? t("entityOps.lock.closed", { date: fmtDate(e.closed_on ?? ""), reason }) : t("entityOps.lock.reach")}</span>
      {lock === "closed" && e.can_manage && <Button onClick={() => setCorrecting(true)}>{t("entityOps.closeFix.action")}</Button>}
      {correcting && <CloseCorrectSheet e={e} onClose={() => setCorrecting(false)} />}
    </div>
  );
}

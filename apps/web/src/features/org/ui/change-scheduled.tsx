import { useState, type ReactNode } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import type { NextStep } from "../present";
import { CancelDialog } from "./cancel-dialog";
import { DraftEditor } from "./draft-editor";
import type { Note } from "./use-note";
import css from "./org-change.module.css";

type Detail = components["schemas"]["OrgChangeDetail"];
type Scheduled = Extract<NextStep, { kind: "scheduled" }>;

/**
 * A scheduled change (org-02): it applies by itself on its effective date from 00:05 KST, and until then it can be moved
 * (schedule edit: the date or the reason; moved to today it applies at once) or cancelled (schedule cancel), each with its
 * consequence said first. A due change the schedule could not apply says why, and can be applied now (`effectuate`).
 */
export function ChangeScheduled({ d, s, title, refetch, onNote, effectuate }: {
  d: Detail;
  s: Scheduled;
  title: string;
  refetch: () => Promise<{ data?: Detail }>;
  onNote: (n: Note) => void;
  effectuate: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const date = fmtDate(d.effectiveDate);
  const refused = [...d.events].reverse().find((e) => e.action === "effectuate.refused");
  return (
    <>
      <p>{s.days > 0 ? t("orgChange.scheduled.title", { date, days: s.days }) : t("orgChange.scheduled.due", { date })}</p>
      <p className="muted">{s.canTouch ? t("orgChange.scheduled.note") : t("orgChange.scheduled.readOnly")}</p>
      {refused?.reason && <p className={css.caution} role="status">{t("orgChange.scheduled.refused", { reason: refused.reason })}</p>}
      {s.canTouch && s.days <= 0 && effectuate}
      {s.canTouch && !editing && (
        <div className={css.bar}>
          <Button id="change-reschedule" onClick={() => setEditing(true)}>{t("orgChange.scheduled.edit")}</Button>
          <span className={css.spacer} />
          <Button variant="ghost-danger" id="change-unschedule" onClick={() => setCancelling(true)}>{t("orgChange.scheduled.cancel")}</Button>
        </div>
      )}
      {editing && <DraftEditor d={d} scheduled refetch={refetch} onSaved={() => undefined} onNote={onNote} onClose={() => setEditing(false)} />}
      <CancelDialog d={d} title={title} scheduled open={cancelling} onClose={() => setCancelling(false)} refetch={refetch} onNote={onNote} />
    </>
  );
}

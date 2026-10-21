import { useEffect, useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { onRecordChange, type RecordChange } from "../../lib/live/live";
import s from "./live.module.css";

/**
 * FE-RT-6: says so when a record on screen was changed by someone else. The screen already shows the new content
 * (the stream re-read it); what the user is typing lives in the form's own draft, which a re-read never replaces,
 * and a save over the change still meets the server's 409 conflict view. The shell keys it by route, so a
 * navigation clears it; so does dismiss.
 */
export function ChangeNotice() {
  const [change, setChange] = useState<RecordChange | null>(null);
  useEffect(() => onRecordChange(setChange), []);
  if (!change) return null;
  return (
    <div className={`notice ${s.notice}`} role="status">
      <span>{t("live.notice.changed_elsewhere", { time: fmtDateTime(change.at) })}</span>
      <button className="btn btn--ghost" onClick={() => setChange(null)}>{t("live.notice.dismiss")}</button>
    </div>
  );
}

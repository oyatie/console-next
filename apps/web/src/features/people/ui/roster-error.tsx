import { RefreshCw } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { failureText } from "../../../lib/refusal";
import { Button } from "../../../ui/button/button";
import { errorOperation } from "../api/record";
import { Banner } from "../../../ui/banner/banner";
import s from "./roster.module.css";

/**
 * The list could not be read (E12-error). Said in one line above the rows: what failed, when, the server's operation
 * for support, and the retry. Rows already read stay below with the time they arrived; nothing is shown that the
 * server did not send.
 */
export function RosterError({ error, kept, at, failedAt, onRetry, retrying }: { error: unknown; kept: boolean; at: number; failedAt: number; onRetry: () => void; retrying: boolean }) {
  const op = errorOperation(error);
  return (
    <div className={s.listError}>
    <Banner tone="danger" live="assertive" actions={<Button onClick={onRetry} aria-disabled={retrying || undefined}><RefreshCw size={14} aria-hidden /> {t("roster.error.retry")}</Button>}>
      <span>
        <b>{t("roster.error.title")}</b> {t("roster.error.why", { why: failureText(error), at: fmtDateTimeShort(new Date(failedAt)) })}
        {op && <> · <span className="code">{op}</span></>}
        {kept ? ` · ${t("roster.error.kept", { at: fmtDateTimeShort(new Date(at)) })}` : ` · ${t("roster.error.none")}`}
      </span>
    </Banner>
    </div>
  );
}

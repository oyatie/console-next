import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { reasonLabel } from "../../../lib/reason-codes";
import { buttonClass } from "../../../ui/button/button-class";
import type { PeriodLock } from "../../../reference/periods/api";
import { domainText, periodText } from "../../../reference/periods/present";
import { QueueSection } from "./change-rows";

/**
 * Period unlocks waiting for this person as their second person (BW-15): what is asked, by whom and until when it
 * waits, each opening its request on the lock page, where they approve it with their own passkey or reject it.
 */
export function UnlockQueue({ locks }: { locks: PeriodLock[] }) {
  return (
    <QueueSection id="unlocks" title={t("home.unlocks.title", { count: locks.length })}>
      <ul className="list-plain">
        {locks.map((l) => {
          const r = l.unlockRequest!;
          const subject = { domain: domainText(l.domain), period: periodText(l) };
          return (
            <li key={l.id} className="row">
              {t("home.unlocks.line", { ...subject, name: r.requestedByName ?? t("periodLocks.closed.removed"), reason: reasonLabel("period_unlock", r.reasonCode), at: fmtDateTime(r.relockAt) })}
              <Link className={buttonClass("primary")} to="/people/period-locks" search={{ review: l.id }}>{t("periodLocks.request.review", subject)}</Link>
            </li>
          );
        })}
      </ul>
    </QueueSection>
  );
}

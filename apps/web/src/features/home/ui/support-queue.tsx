// SPDX-License-Identifier: LicenseRef-Proprietary
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime, fmtNumber } from "@console/i18n/format";
import { buttonClass } from "../../../ui/button/button-class";
import type { ActiveSessions } from "../../support-access/api";
import { QueueSection } from "./change-rows";

/** G2 absorbs this source into 업무함; decisions stay on the shared support-access screen. */
export function SupportQueue({ requests }: { requests: ActiveSessions["pending_approvals"] }) {
  return <QueueSection id="support" title={t("supportAccess.pending", { count: fmtNumber(requests.length) })}>
    <ul className="list-plain">{requests.map((r) => <li key={r.id} className="row">
      {r.operator_label} · {r.ticket_ref} · {r.reason} · {t("supportAccess.requestDeadline", { at: fmtDateTime(r.request_expires_at) })}
      <Link className={buttonClass("primary")} to="/audit/support-access" search={{ review: r.id }}>{t("supportAccess.review")}</Link>
    </li>)}</ul>
  </QueueSection>;
}

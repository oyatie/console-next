import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { components } from "@console/api/schema";
import { codeText } from "../../../lib/labels";
import { QueueSection } from "./change-rows";

type ChangeRequest = components["schemas"]["ChangeRequest"];

/**
 * Change requests waiting for HR (BW-17), oldest concern first as the server lists them: what is asked and why, each
 * opening beside the request list, where HR applies or declines it.
 */
export function RequestQueue({ page }: { page: { items: ChangeRequest[]; total: number } }) {
  return (
    <QueueSection id="requests" title={t("home.requests.title", { count: page.total })}>
      <ul className="list-plain">
        {page.items.map((r) => (
          <li key={r.id} className="row">
            <span className="grow">{t("home.requests.line", { kind: codeText(`requests.kind.${r.kind}`, r.kind), reason: r.reason_code })}</span>
            <span className="muted num">{fmtDateTime(r.created_at)}</span>
            <Link className="btn btn--ghost" to="/people/requests" search={{ sel: r.id }}>{t("home.requests.open")}</Link>
          </li>
        ))}
      </ul>
      {page.total > page.items.length && <Link to="/people/requests">{t("home.requests.all", { count: page.total })}</Link>}
    </QueueSection>
  );
}

// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { codeText } from "../../../lib/code-text";
import { QueryState } from "../../../lib/react/query-state";
import { WorklistPadded } from "../../../ui/patterns/worklist-parts";
import { itemActivityQuery } from "../api";

/** The activity list under the record's facts; the server resolves the item through my own inbox, so it reads only mine. */
export function InboxActivity({ id, padded = false, hideEmpty = false }: { id: string; padded?: boolean; hideEmpty?: boolean }) {
  const activity = useQuery(itemActivityQuery(id));
  if (hideEmpty && activity.isSuccess && (activity.data?.items.length ?? 0) === 0) return null;
  const section = <section aria-labelledby="inbox-activity">
    <h4 id="inbox-activity">{t("home.inbox.activity.title")}</h4>
    <QueryState q={activity} layout="list">{data => <ol className="list-plain">
      {data.items.map((row, index) => <li key={`${row.occurred_at}-${index}`}>
        {codeText(`home.inbox.activity.verb.${row.verb}`, t("home.inbox.activity.verb.other"))} · {row.actor_name ?? t("home.inbox.activity.system")} · <time className="muted num" dateTime={row.occurred_at}>{fmtDateTime(row.occurred_at)}</time>
      </li>)}
      {!data.items.length && <li className="muted">{t("home.inbox.activity.empty")}</li>}
    </ol>}</QueryState>
  </section>;
  return padded ? <WorklistPadded>{section}</WorklistPadded> : section;
}

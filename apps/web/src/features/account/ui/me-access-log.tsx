// SPDX-License-Identifier: LicenseRef-Proprietary
import type { UseQueryResult } from "@tanstack/react-query";
import { Eye } from "lucide-react";
import { i18n, isMessageId, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { codeText } from "../../../lib/labels";
import { QueryState } from "../../../lib/react/query-state";
import { ReadReference } from "../../../lib/react/read-reference";
import { EmptyState } from "../../../ui/empty-state";
import type { MyAccessLogEvent } from "../api";
import s from "./account.module.css";

function shortKstDate(occurredAt: string): string {
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) return fmtDate(occurredAt);
  if (i18n.locale === "ko") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
  return fmtDate(occurredAt);
}

function fieldLabel(field: string | null): string | null {
  if (!field) return null;
  const key = `account.accessLog.field.${field.toUpperCase()}`;
  return isMessageId(key) ? t(key) : field;
}

function reasonLabel(reasonCode: string | null): string | null {
  if (!reasonCode) return null;
  const rrnKey = `reason.rrn_reveal.${reasonCode}`;
  if (isMessageId(rrnKey)) return t(rrnKey);
  return codeText(`reason.${reasonCode}`, reasonCode);
}

export function MyAccessLogBody({
  q,
}: {
  q: UseQueryResult<{ items: MyAccessLogEvent[]; next_cursor: string | null }>;
}) {
  return (
    <QueryState
      q={q}
      compact
      denied={
        <EmptyState
          compact
          title={t("account.accessLog.refused.title")}
          reason={t("account.accessLog.refused")}
          meta={<ReadReference error={q.error} />}
        />
      }
    >
      {data => {
        if (data.items.length === 0) {
          return <div className="muted t-sm">{t("account.accessLog.empty")}</div>;
        }
        return (
          <ul className="list-plain">
            {data.items.map(item => {
              const actor = [item.actor_team, item.actor_name].filter(Boolean).join(" ");
              const field = fieldLabel(item.field);
              const reason = reasonLabel(item.reason_code);
              const when = shortKstDate(item.occurred_at);
              const summary = field
                ? t("account.accessLog.viewedField", { actor, field })
                : t("account.accessLog.viewedAction", {
                    actor,
                    action: codeText(`accessLog.action.${item.action}`, item.action),
                  });
              const meta = [reason, when].filter(Boolean).join(" · ");
              return (
                <li key={item.event_id} className={s.logRow}>
                  <Eye size={16} aria-hidden="true" className={`muted ${s.logIcon}`} />
                  <div className={s.logBody}>
                    <div className="t-sm">{summary}</div>
                    <div className="t-xs muted num">{meta}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        );
      }}
    </QueryState>
  );
}

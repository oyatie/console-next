import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { accessRequestsQuery, closeAccessRequest, type AccessRequest } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Table } from "../../../ui/table";
import type { Account } from "../api";
import { personLabel } from "../../../reference/person/present";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import s from "./access.module.css";

/**
 * The open access requests (governance-22, people-self-38): who asked, from which screen, why and when; grant to them in place, or
 * close the request as done or declined. Drawn only while one is open, so a granter is never left with a request they
 * cannot see.
 */
export function AccessRequests({ accounts, onGrant }: { accounts: readonly Account[]; onGrant: (a: Account) => void }) {
  const q = useQuery(accessRequestsQuery);
  const close = useCommand({
    run: (v: { id: string; status: "DONE" | "DECLINED" }) => closeAccessRequest(v.id, v.status),
    invalidates: ["/api/v1/access"],
  });
  const open = (q.data ?? []).filter((r) => r.status === "OPEN");
  if (!open.length) return null;
  const who = (r: AccessRequest) => accounts.find((a) => a.id === r.requested_by);
  return (
    <Card title={t("accessGrants.requests", { count: open.length })} flush>
      <CommandError error={close.error} />
      <Table
        label={t("accessGrants.requests", { count: open.length })}
        rows={open}
        rowId={(r) => r.id}
        columns={[
          { header: t("access.col.person"), cell: (r) => <PersonLabel person={who(r) ?? { id: r.requested_by, display_name: r.requester_name }} peers={accounts} /> },
          { header: t("accessGrants.requests.screen"), cell: (r) => <span className="code">{r.screen}</span> },
          { header: t("accessGrants.requests.why"), cell: (r) => [t(`common.denied.reason.${r.reason_code}`), r.note].filter(Boolean).join(" · ") },
          { header: t("accessGrants.requests.when"), fit: true, cell: (r) => fmtDateTime(r.created_at) },
          {
            header: <span className="sr-only">{t("access.roles.col.actions")}</span>,
            fit: true,
            cell: (r) => (
              <span className={s.actions}>
                {who(r) && <Button variant="ghost" aria-label={t("people.label.grant", { name: personLabel(who(r)!, accounts).text })} onClick={() => onGrant(who(r)!)}>{t("access.grant.title")}</Button>}
                <Button variant="ghost" disabled={close.isPending} onClick={() => close.mutate({ id: r.id, status: "DONE" })}>{t("accessGrants.requests.done")}</Button>
                <Button variant="ghost-danger" disabled={close.isPending} onClick={() => close.mutate({ id: r.id, status: "DECLINED" })}>{t("accessGrants.requests.decline")}</Button>
              </span>
            ),
          },
        ]}
      />
    </Card>
  );
}

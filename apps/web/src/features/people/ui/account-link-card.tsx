import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { ROLE, label } from "../../../lib/labels";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { Card } from "../../../ui/card/card";
import { buttonClass } from "../../../ui/button/button-class";
import { linkAccount } from "../api";
import { directorySearch, useLinkedAccount } from "./use-linked-account";

type Employee = components["schemas"]["Employee"];

/**
 * The ops account's banner on this employee's exit (governance-03): the same lookup as the card below. There is no
 * ops handover yet, so the exit is not blocked; the sheet says the account stays and where its link is changed.
 */
export function OpsExitNote({ employeeId, search }: { employeeId: string; search: string }) {
  const q = useQuery(directorySearch(search, true));
  if (!q.data?.items.some((p) => p.employee_id === employeeId && p.is_tenant_ops)) return null;
  return <Banner tone="warn">{t("accounts.ops.exitNote")}</Banner>;
}

/**
 * The sign-in account linked to this employee. Unlinked: search open, unlinked accounts (the employee's
 * name is only the first query, nothing is picked for the user) and link one; none found leads to the
 * accounts view to invite one.
 */
export function AccountLinkCard({ employee, manage }: { employee: Employee; manage: boolean }) {
  const { mine, linked } = useLinkedAccount(employee);
  const [query, setQuery] = useState(employee.name);
  const found = useQuery({ ...directorySearch(query.trim()), enabled: manage && mine.isSuccess && !linked && query.trim().length > 0 });
  const candidates = found.data?.items.filter((p) => p.employee_link_status === "UNLINKED" && p.is_active) ?? [];
  const [account, setAccount] = useState<string | null>(null);
  const navigate = useNavigate();
  const link = useCommand({
    run: (userId: string | null) => linkAccount(userId ?? linked!.id, userId ? employee.id : null),
    invalidates: ["/api/v1/directory", "/api/v1/employees"],
    onSuccess: () => setAccount(null),
    announce: (_, userId) => (userId ? t("people.account.linked", { name: candidates.find((p) => p.id === userId)?.display_name ?? "" }) : t("people.account.unlinked")),
  });
  const shown = linked && t("person.account.linked", { name: linked.display_name, roles: linked.roles.map((r) => label(ROLE, r)).join(", ") });
  return (
    <Card titleId="account" title={t("people.account.title")}>
      {/* Until the account lookup succeeds, nothing is said about a link (a failed read is not "unlinked"). */}
      {!mine.isSuccess ? (
        <QueryState q={mine}>{() => null}</QueryState>
      ) : !manage ? (
        <span>{shown || t("accounts.unlinked")}</span>
      ) : linked ? (
        <div className="row">
          <span className="grow">{shown}</span>
          {/* Roles and scopes live with the account (E11-access): the person view says what this account can do and why. */}
          <Link className={buttonClass("ghost")} to="/access/people/$accountId" params={{ accountId: linked.id }}>{t("access.person.title")}</Link>
          <Button variant="ghost" disabled={link.isPending} onClick={() => link.mutate(null)}>{t("people.account.unlink")}</Button>
        </div>
      ) : (
        <>
          {/* The invite opens on this person: the accounts view's invite sheet preselects them (design §3.6, §7.4). */}
          <ServerPicker
            label={t("person.account.picker")}
            group={t("person.account.group")}
            query={query}
            onQueryChange={setQuery}
            options={candidates.map((p) => ({ id: p.id, name: p.display_name, status: p.roles.map((r) => label(ROLE, r)).join(", ") }))}
            value={account}
            onChange={setAccount}
            loading={found.isFetching}
            empty={t("person.account.empty")}
            escape={{ kind: "add", label: t("people.account.invite"), onAdd: () => void navigate({ to: "/people", search: { view: "accounts", act: "invite", employee: employee.id } }) }}
          />
          {account && (
            <div className="row">
              <Button variant="primary" disabled={link.isPending} onClick={() => link.mutate(account)}>{t("people.account.link")}</Button>
            </div>
          )}
        </>
      )}
      <CommandError error={link.error ?? found.error} />
    </Card>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { linkAccount, mySub } from "../api";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { QueryState } from "../../../lib/react/query-state";
import { ROLE, label } from "../../../lib/labels";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { Card } from "../../../ui/card/card";
import { buttonClass } from "../../../ui/button/button-class";
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
  const candidates = found.data?.items.filter((p) => p.employee_link_status === "UNLINKED" && p.is_active && p.id !== mySub()) ?? [];
  const [account, setAccount] = useState<string | null>(null);
  const navigate = useNavigate();
  const link = useCommand({
    run: ({ id, requestId }: { id: string | null; requestId?: string }) => linkAccount(id ?? linked!.id, id ? employee.id : null, requestId),
    invalidates: ["/api/v1/directory", "/api/v1/employees"],
    onSuccess: (result) => { if (!("account_link" in result)) setAccount(null); },
    announce: (result, { id }) => ("account_link" in result ? t("people.account.waiting") : id ? t("people.account.linked", { name: candidates.find((p) => p.id === id)?.display_name ?? "" }) : t("people.account.unlinked")),
  });
  const pending = link.data && "account_link" in link.data && link.data.account_link?.status === "PENDING" ? link.data.account_link : undefined;
  const canChange = manage && linked?.id !== mySub();
  const shown = linked && t("person.account.linked", { name: linked.display_name, roles: linked.roles.map((r) => label(ROLE, r)).join(", ") });
  return (
    <Card titleId="account" title={t("people.account.title")}>
      {/* Until the account lookup succeeds, nothing is said about a link (a failed read is not "unlinked"). */}
      {!mine.isSuccess ? (
        <QueryState q={mine}>{() => null}</QueryState>
      ) : !canChange || linked ? (
        <div className="row">
          <span className="grow">{shown || t("accounts.unlinked")}</span>
          {/* Roles and scopes live with the account (E11-access): the person view says what this account can do and why. */}
          {canChange && linked && <>
            <Link className={buttonClass("ghost")} to="/access/people/$accountId" params={{ accountId: linked.id }}>{t("access.person.title")}</Link>
            {!pending && <Button variant="ghost" disabled={link.isPending} onClick={() => link.mutate({ id: null })}>{t("uiOverrideSheet.stepUp", { action: t("people.account.unlink") })}</Button>}
          </>}
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
          {account && !pending && (
            <div className="row">
              <Button variant="primary" disabled={link.isPending} onClick={() => link.mutate({ id: account })}>{t("uiOverrideSheet.stepUp", { action: t("people.account.link") })}</Button>
            </div>
          )}
        </>
      )}
      {pending && <Banner tone="info" live="polite"
        title={t("people.account.pending", {
          account: link.data?.display_name ?? "",
          employee: pending.employee_id ? employee.name : t("accounts.unlinked"), requester: pending.requester_name,
        })}
        actions={pending.requested_by !== mySub() && <Button variant="primary" disabled={link.isPending}
          onClick={() => link.mutate({ id: pending.employee_id ? pending.user_id : null, requestId: pending.request_id })}>
          {t("uiOverrideSheet.stepUp", { action: t("org.change.step.APPROVED") })}
        </Button>}
      />}
      <PasskeyError error={link.error} />
      {found.error != null && <QueryState q={found}>{() => null}</QueryState>}
    </Card>
  );
}

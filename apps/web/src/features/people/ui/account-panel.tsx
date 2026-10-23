import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { KeyRound, X } from "lucide-react";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Banner } from "../../../ui/banner/banner";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Receipt } from "../../../ui/receipt/receipt";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { useCommand } from "../../../lib/react/command";
import { get } from "../../../lib/query";
import { ACCOUNT_STATUS, EMPLOYEE_STATUS, label, labeled } from "../../../lib/labels";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { checkedOnAccount, linkAccount, mySub, resetPasskeys, setAccountActive } from "../api";
import { holdsActive, holdsLink } from "../domain/accounts";
import { useIssueCode, type Issued } from "./use-issue-code";
import { useCan } from "../../../reference/authz/ui/use-can";
import { Sheet } from "../../../ui/sheet/sheet";
import { BindingEvidence, BindingReviewChip } from "./binding-evidence";
import { SignInId } from "./account-sign-in-id";
import { personLabel } from "../../../reference/person/present";
import { personOption } from "../../../reference/person/ui/person-option";
import { PersonLabel } from "../../../reference/person/ui/person-label";
import { Muted } from "../../../ui/muted/muted";

/** The facts the panel shows: a directory row or the account read on its own (which adds only `phone`). */
type User = components["schemas"]["DirectoryPerson"];
const INVALIDATES = ["/api/v1/directory", "/api/v1/users"] as const;
/** The account screens' words for their typed refusals (governance-01/22): `accounts.code.<code>`, else none. */
const own = (code: string | undefined) => {
  const id = `accounts.code.${code}`;
  return code && isMessageId(id) ? t(id) : undefined;
};
const codeOf = (e: unknown) => (typeof e === "object" && e !== null && "code" in e && typeof e.code === "string" ? e.code : undefined);


/**
 * One account, least destructive first (access, employee link, sign-in), account actions last. Read-only without
 * `user_manage`. `receipt` is the last recorded change to this account, shown at the head (role="status"). There are
 * no preset roles (governance-01): the access section links to what the account may do and to granting access.
 */
export function AccountPanel({ id, row, admin, receipt, onClose, onIssued, onRecorded }: {
  id: string;
  /** The account's row when the list has it loaded: its facts, so a reader outside the users read scope sees them. */
  row?: User;
  admin: boolean;
  receipt?: string;
  onClose: () => void;
  onIssued: (r: Issued) => void;
  onRecorded: (message: string) => void;
}) {
  // An account the list has not loaded (a deep link, the account just invited under a filter) is read on its own.
  const q = useQuery({ ...get("/api/v1/users/{id}", { params: { path: { id } } }), enabled: !row });
  const u = row ?? q.data;
  const [reviewOpen, setReviewOpen] = useState(false);
  const can = useCan();
  return (
    <aside className="card panel" aria-labelledby="acct-title">
      <div className="panel__head">
        <h2 id="acct-title" className="panel__title" tabIndex={-1}>{u?.display_name ?? t("accounts.title")}</h2>
        <Button variant="ghost" onClick={onClose} aria-label={t("common.closePanel")}><X size={16} aria-hidden /></Button>
      </div>
      {can("employee_directory_manage", "branch") && <BindingReviewChip subjectId={id} onOpen={() => setReviewOpen(true)} />}
      {reviewOpen && <Sheet open title={t("identity.binding.title")} onClose={() => setReviewOpen(false)} consequence={null} actions={<Button onClick={() => setReviewOpen(false)}>{t("common.closePanel")}</Button>}>
        <BindingEvidence subjectId={id} />
      </Sheet>}
      {receipt && <Receipt state="recorded" message={receipt} />}
      {u ? <Sections u={u} admin={admin} onIssued={onIssued} onRecorded={onRecorded} /> : <QueryState q={q}>{() => null}</QueryState>}
    </aside>
  );
}

function Sections({ u, admin, onIssued, onRecorded }: { u: User; admin: boolean; onIssued: (r: Issued) => void; onRecorded: (m: string) => void }) {
  const st = labeled(ACCOUNT_STATUS, u.account_status);
  const issue = useIssueCode(onIssued);
  return (
    <>
      <dl className="kv">
        <dt>{t("accounts.field.status")}</dt>
        <dd><Chip tone={st.tone}>{st.label}</Chip> {!u.is_active && <Chip>{t("accounts.inactive")}</Chip>}</dd>
        <dt>{t("accounts.field.created")}</dt>
        <dd className="num">{fmtDateTime(u.created_at)}</dd>
      </dl>
      <Section title={t("accounts.section.access")}>
        {u.is_tenant_ops ? (
          <Muted>{t("accounts.access.ops")}</Muted>
        ) : (
          <div className="row">
            <Link to="/access/people/$accountId" params={{ accountId: u.id }}>{t("accounts.access.view")}</Link>
            {admin && u.is_active && <Link to="/access/people/$accountId" params={{ accountId: u.id }} search={{ grant: true }} className="btn" aria-label={t("people.label.grant", { name: personLabel(u).text })}>{t("accounts.access.grant")}</Link>}
          </div>
        )}
      </Section>
      <Section title={t("accounts.section.employee")}>
        <EmployeeLink u={u} admin={admin} onRecorded={onRecorded} />
      </Section>
      <Section title={t("accounts.section.signIn")}>
        <SignInId u={u} admin={admin} onRecorded={onRecorded} />
        <span>{t("accounts.signIn.passkey", { state: t(u.has_passkey ? "accounts.passkey.yes" : "accounts.passkey.no") })}</span>
        {admin && !u.has_passkey && u.is_active && (
          <>
            <Muted>{t("accounts.signIn.none")}</Muted>
            <div className="row">
              <Button disabled={issue.isPending} onClick={() => issue.mutate({ id: u.id, name: u.display_name, branch: u.branch_ids[0], signInId: u.sign_in_id })}>
                <KeyRound size={16} aria-hidden /> {t("accounts.issueCode")}
              </Button>
            </div>
            <PasskeyError error={issue.error} />
          </>
        )}
      </Section>
      {admin && <Danger u={u} onIssued={onIssued} onRecorded={onRecorded} />}
    </>
  );
}

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="form" aria-label={title}>
    <h3 className="field__label">{title}</h3>
    {children}
  </section>
);

/** The linked employee record (a link to it), or a server search to link one; unlinking keeps both records. */
function EmployeeLink({ u, admin, onRecorded }: { u: User; admin: boolean; onRecorded: (m: string) => void }) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const found = useQuery({ ...get("/api/v1/employees", { params: { query: { search: query.trim(), limit: 20 } } }), enabled: admin && query.trim() !== "" });
  const options = found.data?.items ?? [];
  const link = useCommand({
    run: ({ employeeId, requestId }: { employeeId: string | null; requestId?: string }) => checkedOnAccount(u.id, () => linkAccount(u.id, employeeId, requestId), holdsLink(employeeId)),
    invalidates: [...INVALIDATES, "/api/v1/employees"],
    onSuccess: (r) =>
      onRecorded("account_link" in r ? t("people.account.waiting") : r.employee_name ? t("accounts.employee.linked", { name: u.display_name, employee: r.employee_name }) : t("accounts.employee.unlinked", { name: u.display_name })),
  });
  const pending = link.data && "account_link" in link.data ? link.data.account_link : undefined;
  const canChange = admin && u.id !== mySub();
  if (pending) return <>
    <Banner tone="info" live="polite"
      title={t("people.account.pending", {
        account: u.display_name,
        employee: pending.employee_id ? options.find((e) => e.id === pending.employee_id)?.name ?? "" : t("accounts.unlinked"),
        requester: pending.requester_name,
      })}
      actions={canChange && pending.requested_by !== mySub() && <Button disabled={link.isPending}
        onClick={() => link.mutate({ employeeId: pending.employee_id, requestId: pending.request_id })}>
        {t("uiOverrideSheet.stepUp", { action: t("org.change.step.APPROVED") })}
      </Button>}
    />
    <PasskeyError error={link.error} />
  </>;
  if (u.employee_id)
    return (
      <div className="row">
        <Link to="/people/$id" params={{ id: u.employee_id }}>{u.employee_number ? t("accounts.employee.code", { name: u.employee_name ?? "", number: u.employee_number }) : u.employee_name}</Link>
        {canChange && <Button variant="ghost" disabled={link.isPending} onClick={() => link.mutate({ employeeId: null })}>{t("uiOverrideSheet.stepUp", { action: t("accounts.employee.unlink") })}</Button>}
        <PasskeyError error={link.error} />
      </div>
    );
  if (!canChange) return <Muted>{t("accounts.unlinked")}</Muted>;
  return (
    <>
      <ServerPicker
        label={t("accounts.employee.pick")}
        query={query}
        onQueryChange={setQuery}
        options={options.map((e) => ({ ...personOption(e, options), status: e.status ? label(EMPLOYEE_STATUS, e.status) : undefined }))}
        value={picked}
        onChange={setPicked}
        group={t("accounts.employee.group")}
        loading={found.isFetching}
        empty={t("accounts.employee.none")}
      />
      {picked && <PersonLabel person={{ ...options.find((p) => p.id === picked), id: picked, employee_id: picked }} peers={options} />}
      {tried && picked === null && <span className="field__error" role="alert">{t("accounts.employee.pickError")}</span>}
      <div className="row">
        <Button disabled={link.isPending} onClick={() => (setTried(true), picked && link.mutate({ employeeId: picked }))}>{t("uiOverrideSheet.stepUp", { action: t("accounts.employee.link") })}</Button>
      </div>
      <PasskeyError error={link.error} />
    </>
  );
}

/** Passkey reset and (de)activation: each confirms its consequence, and the irreversible ones ask for the admin's passkey. */
function Danger({ u, onIssued, onRecorded }: { u: User; onIssued: (r: Issued) => void; onRecorded: (m: string) => void }) {
  const [open, setOpen] = useState<"reset" | "deactivate" | null>(null);
  const reset = useCommand({
    run: async (): Promise<Issued> => ({ name: u.display_name, userId: u.id, reset: true, signInId: u.sign_in_id, ...(await resetPasskeys(u.id)) }),
    invalidates: INVALIDATES,
    onSuccess: (r) => (setOpen(null), onIssued(r), onRecorded(t("accounts.reset.done", { name: u.display_name }))),
    announce: () => t("accounts.reset.done", { name: u.display_name }),
    forget: true,
  });
  const toggle = useCommand({
    run: () => checkedOnAccount(u.id, () => setAccountActive(u.id, !u.is_active), holdsActive(!u.is_active)),
    invalidates: INVALIDATES,
    onSuccess: () => (setOpen(null), onRecorded(t(u.is_active ? "accounts.deactivated" : "accounts.activated", { name: u.display_name }))),
    announce: () => t(u.is_active ? "accounts.deactivated" : "accounts.activated", { name: u.display_name }),
  });
  const close = () => (setOpen(null), reset.reset(), toggle.reset());
  const confirm = open === "reset"
    ? { title: t("accounts.reset"), text: t("accounts.reset.consequence", { name: u.display_name }), commit: t("accounts.reset.commit"), cmd: reset }
    : { title: t("accounts.deactivate"), text: t("accounts.deactivate.consequence", { name: u.display_name }), commit: t("accounts.deactivate.commit"), cmd: toggle };
  // governance-22: the ops account and one's own account are never deactivated; the reason replaces the action.
  const keep = u.is_tenant_ops ? "accounts.deactivate.ops" : u.id === mySub() ? "accounts.deactivate.own" : null;
  return (
    <Section title={t("accounts.section.danger")}>
      <div className="row">
        {/* governance-02: one's own reset deletes the passkey in use (the solo ops holder's lockout); My account adds one. */}
        {u.is_active && u.has_passkey && (u.id === mySub() ? (
          <DisabledReason
            reason={t("accounts.reset.own")}
            remedy={<Link to="/account">{t("accounts.reset.ownFix")}</Link>}
            control={(c) => <Button variant="ghost-danger" {...c}>{t("accounts.reset")}</Button>}
          />
        ) : <Button variant="ghost-danger" onClick={() => setOpen("reset")}>{t("accounts.reset")}</Button>)}
        {u.is_active && keep ? (
          <Muted>{t(keep)}</Muted>
        ) : u.is_active ? (
          <Button variant="ghost-danger" onClick={() => setOpen("deactivate")}>{t("accounts.deactivate")}</Button>
        ) : (
          <Button disabled={toggle.isPending} onClick={() => toggle.mutate(undefined)}>{t("accounts.activate")}</Button>
        )}
      </div>
      {open === null && <CommandError error={toggle.error} own={own} />}
      <Dialog open={open !== null} title={confirm.title} onClose={close} dismissable={!confirm.cmd.isPending}>
        <Muted>{confirm.text}</Muted>
        {own(codeOf(confirm.cmd.error)) ? <CommandError error={confirm.cmd.error} own={own} /> : <PasskeyError error={confirm.cmd.error} />}
        <div className="form__actions">
          <Button onClick={close} disabled={confirm.cmd.isPending}>{t("common.back")}</Button>
          <Button variant="danger" disabled={confirm.cmd.isPending} onClick={() => confirm.cmd.mutate(undefined)}>
            <KeyRound size={16} aria-hidden /> {confirm.commit}
          </Button>
        </div>
      </Dialog>
    </Section>
  );
}

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { Sheet } from "../../../ui/sheet/sheet";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { ServerPicker } from "../../../ui/server-picker/server-picker";
import { CommandError } from "../../../lib/react/command-error";
import { useCommand } from "../../../lib/react/command";
import { get } from "../../../lib/query";
import { EMPLOYEE_STATUS, label } from "../../../lib/labels";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { createAccount, employeeQuery } from "../api";
import { useFocusInvalid } from "./use-focus-invalid";
import { useIssueCode, type Issued } from "./use-issue-code";
import { inviteBlock, LOGIN_MAX, loginProblem, normalizeLogin, suggestLogin } from "../domain/sign-in-id";
import { Muted } from "../../../ui/muted/muted";

type Employee = components["schemas"]["Employee"];
const CURRENT = ["ACTIVE", "ON_LEAVE", "UNKNOWN"] as const;
/** The invite's typed refusals (governance-01): `accounts.code.<code>`, else the shared wording. */
const own = (code: string) => {
  const id = `accounts.code.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

/**
 * Invites an account for a person: an employee picked from the server (preselected when opened from their record), or,
 * by an explicit switch, someone who is not an employee. There are no preset roles (governance-01): the account is
 * created with no access, and the code dialog continues into granting access. An employee who already has an account stops
 * the invite and opens that account instead. The account is created already linked (one keyed request), then the
 * admin's passkey step-up mints the first sign-in code; a failed code retries alone.
 */
export function InviteSheet({ employeeId, onClose, onIssued, onOpenAccount }: {
  employeeId?: string;
  onClose: () => void;
  onIssued: (r: Issued) => void;
  onOpenAccount: (userId: string) => void;
}) {
  const [nonEmployee, setNonEmployee] = useState(false);
  const [query, setQuery] = useState<string>();
  const [picked, setPicked] = useState<Employee | null>();
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [box, focusInvalid] = useFocusInvalid<HTMLDivElement>();
  const preset = useQuery({ ...employeeQuery(employeeId ?? ""), enabled: Boolean(employeeId) && picked === undefined });
  const who = nonEmployee ? null : picked === undefined ? (preset.data?.employee ?? null) : picked;
  const text = query ?? who?.name ?? "";
  const found = useQuery({
    ...get("/api/v1/employees", { params: { query: { search: text.trim(), status: [...CURRENT], limit: 20 } } }),
    enabled: !nonEmployee && text.trim() !== "" && text !== who?.name,
  });
  const options = [...(found.data?.items ?? []), ...(who && !found.data?.items.some((e) => e.id === who.id) ? [who] : [])];
  // The directory searches the linked employee's number, so an existing account for this person is one read away.
  const linked = useQuery({
    ...get("/api/v1/directory/people", { params: { query: { search: who?.employee_number ?? who?.name ?? "", include_inactive: true, limit: 20 } } }),
    enabled: who != null,
  });
  const existing = who ? linked.data?.items.find((p) => p.employee_id === who.id) : undefined;
  const displayName = nonEmployee ? name.trim() : (who?.name ?? "");
  // The sign-in ID (decisions #33): suggested from the name (else the employee number) until the admin types one;
  // empty takes the server's default. The domain is the admin's own, read from their account.
  const [login, setLogin] = useState<string | null>(null);
  const loginValue = login ?? suggestLogin(displayName, who?.employee_number);
  const loginError = loginValue.trim() ? loginProblem(loginValue) : null;
  const domain = useQuery(get("/api/v1/users/me")).data?.sign_in_id?.split("@")[1];

  // The account, once created: a failed code issue then retries only the issue, never the creation.
  const [created, setCreated] = useState<{ id: string; name: string; signInId?: string | null } | null>(null);
  const issue = useIssueCode(onIssued);
  const create = useCommand({
    run: (_: void, key: string) =>
      createAccount({ display_name: displayName, employee_id: who?.id, roles: [], branch_ids: [], ...(loginValue.trim() ? { sign_in_id: normalizeLogin(loginValue) } : {}) }, key),
    invalidates: ["/api/v1/directory", "/api/v1/users"],
    onSuccess: (user) => {
      const target = { id: user.id, name: user.display_name, signInId: user.sign_in_id };
      setCreated(target);
      issue.mutate(target);
    },
  });
  const block = inviteBlock({ created: created !== null, nonEmployee, who: who !== null, name: displayName, login: loginValue, existing: !!existing, checking: linked.isFetching });
  const blockedWhy = block ? t(block) : null;
  const commit = () => {
    setTried(true);
    if (created) return issue.mutate(created);
    if (block) return focusInvalid();
    create.mutate(undefined);
  };
  const pending = create.isPending || issue.isPending;
  const consequence =
    displayName === ""
      ? t("accounts.invite.consequence.pending")
      : who?.employee_number
        ? t("accounts.invite.consequence", { name: displayName, number: who.employee_number })
        : t("accounts.invite.consequence.nonEmployee", { name: displayName });

  return (
    <Sheet
      open
      title={t("accounts.invite")}
      onClose={onClose}
      pending={pending}
      consequence={<span>{consequence}</span>}
      actions={
        <>
          <Button onClick={onClose} disabled={pending}>{t("common.back")}</Button>
          {blockedWhy ? (
            <DisabledReason
              control={(p) => (
                <Button variant="primary" {...p} onClick={(e) => { p.onClick(e); commit(); }}>
                  <KeyRound size={16} aria-hidden /> {t("accounts.invite.commit")}
                </Button>
              )}
              reason={blockedWhy}
            />
          ) : (
            <Button variant="primary" onClick={commit} disabled={pending}>
              <KeyRound size={16} aria-hidden /> {created ? t("accounts.invite.retryCode") : t("accounts.invite.commit")}
            </Button>
          )}
        </>
      }
    >
      <div ref={box} className="form">
        <fieldset className="form__group" disabled={created !== null}>
          {nonEmployee ? (
            <Field label={t("accounts.invite.name")} required  error={tried && displayName === "" ? t("accounts.invite.pickName") : undefined}>
              {(p) => <TextInput {...p} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />}
            </Field>
          ) : (
            <ServerPicker
              label={t("accounts.invite.who")}
              query={text}
              onQueryChange={setQuery}
              options={options.map((e) => ({ id: e.id, name: e.name, code: e.employee_number ?? undefined, status: e.status ? label(EMPLOYEE_STATUS, e.status) : undefined, context: e.org_unit ?? undefined }))}
              value={who?.id ?? null}
              onChange={(id) => setPicked(options.find((e) => e.id === id) ?? null)}
              group={t("accounts.invite.who.group")}
              loading={found.isFetching}
              empty={t("accounts.invite.who.none")}
              isRequired
            />
          )}
          {!nonEmployee && tried && who == null && <span className="field__error" role="alert">{t("accounts.invite.pickWho")}</span>}
          <Field
            label={t("accounts.invite.signInId")}
            required={false}
            unit={domain ? `@${domain}` : undefined}
            error={tried && loginError && loginError !== "empty" ? t(`accounts.signInId.problem.${loginError}`) : undefined}
          >
            {(p) => (
              <TextInput {...p} value={loginValue} maxLength={LOGIN_MAX} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setLogin(e.target.value)} />
            )}
          </Field>
          <div className="row">
            <Button variant="ghost" onClick={() => (setNonEmployee(!nonEmployee), setTried(false))}>
              {t(nonEmployee ? "accounts.invite.fromEmployees" : "accounts.invite.nonEmployee")}
            </Button>
          </div>
          {who && linked.isFetching && <span className="muted" role="status">{t("accounts.invite.checking")}</span>}
          {existing && (
            <div className="alert" role="alert">
              {t("accounts.invite.exists")}
              <Button variant="ghost" onClick={() => onOpenAccount(existing.id)}>{t("accounts.invite.openExisting")}</Button>
            </div>
          )}
        </fieldset>
      </div>
      {created && issue.error ? <Muted>{t("accounts.invite.created", { name: created.name })}</Muted> : null}
      <CommandError error={create.error} own={own} />
      <PasskeyError error={issue.error} />
    </Sheet>
  );
}

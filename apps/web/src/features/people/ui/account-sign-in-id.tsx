import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { todayKst } from "../../../lib/pure/today";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { reasonCodesQuery, reasonLabel, useNeedsNote } from "../../../lib/reason-codes";
import { ReasonCodeField } from "../../../reference/reason/ui/reason-code-field";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { DateField } from "../../../ui/date/date-field";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { Field, TextInput } from "../../../ui/field/field";
import { TextArea } from "../../../ui/field/text-area";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Table } from "../../../ui/table";
import { changeSignInId, signInIdsQuery } from "../api";
import { changeProblem, LOGIN_MAX, normalizeLogin } from "../domain/sign-in-id";

const DOMAIN = "sign_in_id_change";
const NOTE_MAX = 1000;
const own = (code: string) => {
  const id = `accounts.code.${code}`;
  return isMessageId(id) ? t(id) : undefined;
};

/**
 * An account's sign-in ID `login@domain` (decisions #33): shown with a copy, changed by a user-manage holder with an
 * effective date and a reason, and its history. The old ID still signs in for 90 days, stays searchable for good and
 * is never given to anyone again, so a change destroys nothing and needs no passkey step-up.
 */
export function SignInId({ u, admin, onRecorded }: {
  u: { id: string; display_name: string; sign_in_id?: string | null };
  admin: boolean;
  onRecorded: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(false);
  const current = u.sign_in_id ?? null;
  const copy = () => current && void navigator.clipboard.writeText(current).then(() => announce(t("accounts.signInId.copied")), () => announce(t("common.copyFailed")));
  return (
    <>
      <KeyValue
        items={[{
          key: "signInId",
          label: t("accounts.signInId"),
          value: <span className="code">{current ?? "—"}</span>,
          action: current ? <Button variant="ghost" onClick={copy}>{t("accounts.signInId.copy")}</Button> : undefined,
        }]}
      />
      {admin && (
        <div className="row">
          <Button aria-expanded={open} onClick={() => setOpen(!open)}>{t("accounts.signInId.change")}</Button>
          <Button variant="ghost" aria-expanded={history} onClick={() => setHistory(!history)}>{t("accounts.signInId.history")}</Button>
        </div>
      )}
      {open && <ChangeForm u={u} current={current} onDone={(message) => (setOpen(false), message && onRecorded(message))} />}
      {history && <History id={u.id} />}
    </>
  );
}

function ChangeForm({ u, current, onDone }: { u: { id: string; display_name: string }; current: string | null; onDone: (message?: string) => void }) {
  const today = todayKst();
  // The reasons load with the form, so it opens whole instead of growing under the pointer.
  useQuery(reasonCodesQuery(DOMAIN));
  const [next, setNext] = useState("");
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const needsNote = useNeedsNote(DOMAIN, reason);
  const problem = changeProblem({ current, next, date, today, reason, needsNote, note });
  const domain = current?.split("@")[1];
  const save = useCommand({
    run: () =>
      changeSignInId(u.id, { login: normalizeLogin(next), effective_date: date, reason_code: reason!, ...(note.trim() ? { note: note.trim() } : {}) }),
    invalidates: ["/api/v1/directory", "/api/v1/users"],
    announce: (r) => t("accounts.signInId.done", { name: u.display_name, id: r.sign_in_id }),
    onSuccess: (r) => onDone(t("accounts.signInId.done", { name: u.display_name, id: r.sign_in_id })),
  });
  const go = t("accounts.signInId.save");
  return (
    <div className="form">
      <Field label={t("accounts.signInId.new")} required hint={t("accounts.signInId.newHint")} unit={domain ? `@${domain}` : undefined}>
        {(p) => <TextInput {...p} value={next} maxLength={LOGIN_MAX} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <DateField label={t("accounts.signInId.effective")} required value={date} onChange={setDate} today={today} max={today} />
      <ReasonCodeField domain={DOMAIN} label={t("accounts.signInId.reason")} value={reason} onChange={setReason} />
      {needsNote && (
        <Field label={t("accounts.signInId.note")} required>
          {(p) => <TextArea {...p} value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      )}
      <ActionBar
        consequence={t("accounts.signInId.consequence")}
        actions={
          <>
            <Button onClick={() => onDone()}>{t("accounts.signInId.cancel")}</Button>
            {problem ? (
              <DisabledReason control={(p) => <Button {...p} variant="primary">{go}</Button>} reason={t(`accounts.signInId.problem.${problem}`)} />
            ) : (
              <Button variant="primary" disabled={save.isPending} onClick={() => save.mutate(undefined)}>{go}</Button>
            )}
          </>
        }
      />
      {/* Under the actions: a refusal lands without moving the button just pressed. */}
      <CommandError error={save.error} own={own} />
    </div>
  );
}

function History({ id }: { id: string }) {
  const q = useQuery(signInIdsQuery(id));
  return (
    <QueryState q={q}>
      {(d) => (
        <Table
          label={t("accounts.signInId.history")}
          rows={d.items}
          rowId={(r) => r.login}
          columns={[
            { header: t("accounts.signInId.col.id"), cell: (r) => <span className="code">{r.sign_in_id}</span> },
            { header: t("accounts.signInId.col.effective"), cell: (r) => <span className="num">{fmtDate(r.effective_date)}</span>, fit: true },
            { header: t("accounts.signInId.col.reason"), cell: (r) => reasonLabel(DOMAIN, r.reason_code) },
            { header: t("accounts.signInId.col.by"), cell: (r) => r.assigned_by_name ?? t("accounts.signInId.by.system") },
            {
              header: t("accounts.signInId.col.state"),
              cell: (r) => (r.state === "ALIAS" && r.alias_until ? t("accounts.signInId.state.ALIAS", { until: fmtDateTime(r.alias_until) }) : t(`accounts.signInId.state.${r.state}`)),
              wide: true,
            },
          ]}
        />
      )}
    </QueryState>
  );
}

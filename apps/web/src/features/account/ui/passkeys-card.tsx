import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { KeyRound, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { useCommand } from "../../../lib/react/command";
import { QueryState } from "../../../lib/react/query-state";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import { Field, TextInput } from "../../../ui/field/field";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table } from "../../../ui/table";
import { addPasskey, passkeyLabelPolicyQuery, removePasskey, renamePasskey } from "../api";
import { passkeyRows, type PasskeyRow } from "../domain/passkeys";
import s from "./account.module.css";

const ADD = "acct-passkey-add";
const RECEIPT = "acct-passkey-receipt";
type NamedPasskey = PasskeyRow & { name: string };

/** My passkeys: add one (step-up with an existing one), remove one (step-up), never the last. */
export function PasskeysCard({ ops, passkeys }: { ops: boolean | undefined; passkeys: UseQueryResult<components["schemas"]["PasskeySummary"][]> }) {
  const [removing, setRemoving] = useState<NamedPasskey | null>(null);
  const [naming, setNaming] = useState<"add" | NamedPasskey | null>(null);
  const [label, setLabel] = useState("");
  const editing = naming && naming !== "add" ? naming : null;
  const policy = useQuery({ ...passkeyLabelPolicyQuery, enabled: naming !== null });
  const max = policy.data?.label_max_length;
  const invalidLabel = max !== undefined && (Array.from(label.trim()).length > max || /\p{Cc}/u.test(label));
  // The server's record of the last command; focus moves to it, since the row or button used may be gone.
  const [receipt, setReceipt] = useState<string | null>(null);
  const recorded = (message: string) => {
    setReceipt(message);
    focusSoon(RECEIPT);
  };
  const add = useCommand({
    run: (input: { before: number; label: string }) => addPasskey(input.before, input.label),
    invalidates: ["/api/v1/auth/passkeys"],
    onSuccess: () => { setNaming(null); recorded(t("account.passkey.added")); },
  });
  const rename = useCommand({
    run: (input: { id: string; label: string }) => renamePasskey(input.id, input.label),
    invalidates: ["/api/v1/auth/passkeys"],
    settle: true,
    onSuccess: () => { setNaming(null); recorded(t("account.passkey.renamed")); },
  });
  const remove = useCommand({
    run: (p: NamedPasskey) => removePasskey(p.id),
    invalidates: ["/api/v1/auth/passkeys"],
    onSuccess: (_, p) => {
      setRemoving(null);
      recorded(t("account.passkey.removed", { name: p.name }));
    },
  });
  const close = () => {
    setRemoving(null);
    remove.reset();
  };
  const closeNaming = () => {
    if (add.isPending || rename.isPending) return;
    setNaming(null);
    add.reset();
    rename.reset();
  };

  return (
    <Card
      title={t("account.passkeys")}
      titleId="acct-passkeys"
      flush
      tools={
        <Button
          id={ADD}
          variant="primary"
          disabled={add.isPending || !passkeys.data}
          onClick={() => {
            setReceipt(null);
            add.reset();
            rename.reset();
            setLabel("");
            setNaming("add");
          }}
        >
          <KeyRound size={16} aria-hidden /> {t("account.passkey.add")}
        </Button>
      }
    >
      <div className={s.pad}>
        {passkeys.data?.length === 1 && ops !== undefined && <p>{t(ops ? "account.second.whyOps" : "account.second.why")}</p>}
        {receipt && (
          <div id={RECEIPT} tabIndex={-1}>
            <Receipt state="recorded" message={receipt} />
          </div>
        )}
      </div>
      <QueryState
        q={passkeys}
        empty={(d) => (d.length ? null : <EmptyState title={t("account.passkey.none.title")} reason={t("account.passkey.none.reason")} />)}
      >
        {(d) => {
          const rows = passkeyRows(d).map((p, index) => ({ ...p, name: p.label ?? t("account.passkey.name", { n: index + 1 }) }));
          const only = rows.length === 1;
          return (
            <>
              <Table
                label={t("account.passkeys")}
                rows={rows}
                rowId={(p) => p.id}
                columns={[
                  { header: t("account.passkey.col.name"), cell: (p) => <span className="row">{p.name}{p.recent && <Chip tone="info">{t("account.passkey.recent")}</Chip>}</span> },
                  { header: t("account.passkey.col.created"), fit: true, wide: true, cell: (p) => <span className={`num ${s.nowrap}`}>{fmtDateTime(p.created_at)}</span> },
                  { header: t("account.passkey.col.lastUsed"), fit: true, cell: (p) => <span className={`num ${s.nowrap}`}>{p.last_used_at ? fmtDateTime(p.last_used_at) : t("account.passkey.neverUsed")}</span> },
                  {
                    header: t("account.passkey.col.actions"),
                    fit: true,
                    cell: (p) => <span className="row">
                      <Button className={s.nowrap} aria-label={t("account.passkey.renameOne", { name: p.name })} onClick={() => { setReceipt(null); rename.reset(); add.reset(); setLabel(p.name); setNaming(p); }}>{t("account.passkey.rename")}</Button>
                      {!only && <Button className={s.nowrap} aria-label={t("account.passkey.removeOne", { name: p.name })} onClick={() => (setReceipt(null), setRemoving(p))}>
                        <Trash2 size={16} aria-hidden /> {t("account.passkey.remove")}
                      </Button>}
                    </span>,
                  },
                ]}
              />
            </>
          );
        }}
      </QueryState>

      <Dialog open={naming !== null} title={editing ? t("account.passkey.renameOne", { name: editing.name }) : t("account.passkey.add")} onClose={closeNaming} read>
        <QueryState q={policy}>
          {() => <Field label={t("account.passkey.label")} required={!!editing} hint={max === undefined ? undefined : t("account.passkey.labelHint", { max })} error={invalidLabel ? t("account.passkey.labelInvalid") : undefined}>
            {(c) => <TextInput {...c} maxLength={max} value={label} placeholder={editing ? undefined : t("account.passkey.name", { n: (passkeys.data?.length ?? 0) + 1 })} onChange={(e) => setLabel(e.target.value)} />}
          </Field>}
        </QueryState>
        <ActionBar notice={<PasskeyError error={editing ? rename.error : add.error} />} actions={<>
          <Button disabled={add.isPending || rename.isPending} onClick={closeNaming}>{t("composer.dismiss")}</Button>
          <Button variant="primary" disabled={add.isPending || rename.isPending || policy.isError || max === undefined || invalidLabel || (!!editing && !label.trim())} onClick={() => {
            if (policy.isError || max === undefined || invalidLabel) return;
            if (editing) rename.mutate({ id: editing.id, label: label.trim() });
            else add.mutate({ before: passkeys.data!.length, label: label.trim() || t("account.passkey.name", { n: passkeys.data!.length + 1 }) });
          }}>{t(editing ? "account.passkey.renameCommit" : "account.passkey.addCommit")}</Button>
        </>} />
      </Dialog>

      <Dialog open={removing !== null} title={removing ? t("account.passkey.removeOne", { name: removing.name }) : ""} onClose={close}>
        {removing && (
          <>
            <span className="muted">{t("account.passkey.removeConsequence")} {removing.recent && t("account.passkey.removeRecent")}</span>
            <ActionBar
              notice={<PasskeyError error={remove.error} />}
              actions={
                <>
                  <Button onClick={close}>{t("composer.dismiss")}</Button>
                  <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>
                    <KeyRound size={16} aria-hidden /> {t("account.passkey.removeCommit", { name: removing.name })}
                  </Button>
                </>
              }
            />
          </>
        )}
      </Dialog>
    </Card>
  );
}

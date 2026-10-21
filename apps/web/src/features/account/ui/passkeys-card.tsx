import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { KeyRound, Trash2 } from "lucide-react";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { focusSoon } from "../../../lib/react/announce";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { useCommand } from "../../../lib/react/command";
import { QueryState } from "../../../lib/react/query-state";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { Dialog } from "../../../ui/dialog";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table } from "../../../ui/table";
import { addPasskey, removePasskey } from "../api";
import { passkeyRows, type PasskeyRow } from "../domain/passkeys";
import s from "./account.module.css";

const ADD = "acct-passkey-add";
const RECEIPT = "acct-passkey-receipt";
const nameOf = (p: PasskeyRow) => t("account.passkey.name", { date: fmtDate(p.day), n: p.nth });

/** My passkeys: add one (step-up with an existing one), remove one (step-up), never the last. */
export function PasskeysCard({ ops, passkeys }: { ops: boolean | undefined; passkeys: UseQueryResult<components["schemas"]["PasskeySummary"][]> }) {
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  // The server's record of the last command; focus moves to it, since the row or button used may be gone.
  const [receipt, setReceipt] = useState<string | null>(null);
  const recorded = (message: string) => {
    setReceipt(message);
    focusSoon(RECEIPT);
  };
  const add = useCommand({
    run: (before: number) => addPasskey(before),
    invalidates: ["/api/v1/auth/passkeys"],
    onSuccess: () => recorded(t("account.passkey.added")),
  });
  const remove = useCommand({
    run: (p: PasskeyRow) => removePasskey(p.id),
    invalidates: ["/api/v1/auth/passkeys"],
    onSuccess: (_, p) => {
      setRemoving(null);
      recorded(t("account.passkey.removed", { name: nameOf(p) }));
    },
  });
  const close = () => {
    setRemoving(null);
    remove.reset();
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
            add.mutate(passkeys.data!.length);
          }}
        >
          <KeyRound size={16} aria-hidden /> {t("account.passkey.add")}
        </Button>
      }
    >
      <div className={s.pad}>
        {passkeys.data?.length === 1 && ops !== undefined && <p>{t(ops ? "account.second.whyOps" : "account.second.why")}</p>}
        <PasskeyError error={add.error} />
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
          const rows = passkeyRows(d);
          const only = rows.length === 1;
          return (
            <>
              <Table
                label={t("account.passkeys")}
                rows={rows}
                rowId={(p) => p.id}
                columns={[
                  { header: t("account.passkey.col.name"), cell: (p) => <span className="row">{nameOf(p)}{p.recent && <Chip tone="info">{t("account.passkey.recent")}</Chip>}</span> },
                  { header: t("account.passkey.col.created"), fit: true, wide: true, cell: (p) => <span className={`num ${s.nowrap}`}>{fmtDateTime(p.created_at)}</span> },
                  { header: t("account.passkey.col.lastUsed"), fit: true, cell: (p) => <span className={`num ${s.nowrap}`}>{p.last_used_at ? fmtDateTime(p.last_used_at) : t("account.passkey.neverUsed")}</span> },
                  {
                    header: t("account.passkey.col.actions"),
                    fit: true,
                    cell: (p) =>
                      only ? (
                        <DisabledReason
                          control={(c) => <Button {...c} className={`${c.className} ${s.nowrap}`}><Trash2 size={16} aria-hidden /> {t("account.passkey.removeOne", { name: nameOf(p) })}</Button>}
                          reason={t("account.passkey.lastReason")}
                          remedy={<Button variant="ghost" onClick={() => document.getElementById(ADD)?.focus()}>{t("account.passkey.addFix")}</Button>}
                        />
                      ) : (
                        <Button className={s.nowrap} onClick={() => (setReceipt(null), setRemoving(p))}>
                          <Trash2 size={16} aria-hidden /> {t("account.passkey.removeOne", { name: nameOf(p) })}
                        </Button>
                      ),
                  },
                ]}
              />
            </>
          );
        }}
      </QueryState>

      <Dialog open={removing !== null} title={removing ? t("account.passkey.removeOne", { name: nameOf(removing) }) : ""} onClose={close}>
        {removing && (
          <>
            <span className="muted">{t("account.passkey.removeConsequence")}</span>
            {removing.recent && <span className="muted">{t("account.passkey.removeRecent")}</span>}
            <ActionBar
              notice={<PasskeyError error={remove.error} />}
              actions={
                <>
                  <Button onClick={close}>{t("common.back")}</Button>
                  <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate(removing)}>
                    <KeyRound size={16} aria-hidden /> {t("account.passkey.removeCommit", { name: nameOf(removing) })}
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

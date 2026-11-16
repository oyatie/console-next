// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCommand } from "../../../lib/react/command";
import { freshOnOpen } from "../../../lib/query";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { Field, TextInput } from "../../../ui/field/field";
import { bindOwnAccount, selfBindingReceipt, withdrawOwnBinding } from "../api/self-binding";
import { AccountLinkEditor } from "./account-link-editor";

export function SelfAccountLink({ employeeId, employeeName, offered = true }: { employeeId: string; employeeName: string; offered?: boolean }) {
  const [name, setName] = useState("");
  const persisted = useQuery({ ...selfBindingReceipt(), refetchOnMount: "always", retry: false });
  const link = useCommand({ run: (confirmedName: string) => bindOwnAccount(employeeId, confirmedName),
    invalidates: ["/api/v1/directory", "/api/v1/employees", "/api/v1/users/me"],
    announce: () => t("people.account.ownLinked") });
  const withdraw = useCommand({ run: withdrawOwnBinding,
    invalidates: ["/api/v1/directory", "/api/v1/employees", "/api/v1/users/me"],
    onSuccess: () => { link.reset(); setName(""); }, announce: () => t("people.account.ownWithdrawn") });
  return <QueryState q={freshOnOpen(persisted)} inline>{({ attestation }) => {
    const receipt = attestation?.employee_id === employeeId ? attestation : null;
    if (!offered && !receipt) return null;
    return <div className="form">
      {!receipt && <Field label={t("people.account.confirmName", { name: employeeName })} required>
        {control => <TextInput {...control} value={name} onChange={event => setName(event.target.value)} disabled={link.isPending} autoComplete="off" />}
      </Field>}
      <div className="row">
        {receipt ? <>
          <Chip tone="warn">{t("people.account.selfAttested")}</Chip>
          {receipt.can_withdraw && <Button disabled={withdraw.isPending} onClick={() => withdraw.mutate(receipt.attestation_id)}>{t("uiOverrideSheet.stepUp", { action: t("people.account.withdrawOwn") })}</Button>}
        </> : <Button disabled={link.isPending || !name || name !== employeeName} onClick={() => link.mutate(name)}>{t("uiOverrideSheet.stepUp", { action: t("people.account.ownLink") })}</Button>}
      </div>
      <AccountLinkEditor busy={link.isPending || withdraw.isPending} error={withdraw.error ?? link.error} />
    </div>;
  }}</QueryState>;
}

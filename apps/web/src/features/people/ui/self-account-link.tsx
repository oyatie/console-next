// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { bindOwnAccount, withdrawOwnBinding } from "../api/self-binding";
import { AccountLinkEditor } from "./account-link-editor";

export function SelfAccountLink({ employeeId, offered = true }: { employeeId: string; offered?: boolean }) {
  const link = useCommand({ run: () => bindOwnAccount(employeeId),
    invalidates: ["/api/v1/directory", "/api/v1/employees", "/api/v1/users/me"],
    announce: () => t("people.account.ownLinked") });
  const withdraw = useCommand({ run: withdrawOwnBinding,
    invalidates: ["/api/v1/directory", "/api/v1/employees", "/api/v1/users/me"],
    onSuccess: () => link.reset(), announce: () => t("people.account.ownWithdrawn") });
  // shortcut: current-view receipt only, use persisted attestation reads for navigation recovery.
  const receipt = link.data?.attestation_id;
  if (!offered && !receipt) return null;
  return <>
    <div className="row">
      {receipt ? <>
        <Chip tone="warn">{t("people.account.selfAttested")}</Chip>
        <Button disabled={withdraw.isPending} onClick={() => withdraw.mutate(receipt)}>{t("uiOverrideSheet.stepUp", { action: t("people.account.withdrawOwn") })}</Button>
      </> : <Button disabled={link.isPending} onClick={() => link.mutate(undefined)}>{t("people.account.ownLink")}</Button>}
    </div>
    <AccountLinkEditor busy={link.isPending || withdraw.isPending} error={withdraw.error ?? link.error} />
  </>;
}

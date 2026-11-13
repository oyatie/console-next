// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { Button } from "../../../ui/button/button";
import { bindOwnAccount } from "../api/self-binding";
import { AccountLinkEditor } from "./account-link-editor";

export function SelfAccountLink({ employeeId }: { employeeId: string }) {
  const link = useCommand({ run: () => bindOwnAccount(employeeId),
    invalidates: ["/api/v1/directory", "/api/v1/employees", "/api/v1/users/me"],
    announce: () => t("people.account.ownLinked") });
  return <>
    <Button disabled={link.isPending} onClick={() => link.mutate(undefined)}>{t("people.account.ownLink")}</Button>
    <AccountLinkEditor busy={link.isPending} error={link.error} />
  </>;
}

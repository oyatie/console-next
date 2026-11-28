// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { announce } from "../../../lib/react/announce";
import { useCommand } from "../../../lib/react/command";
import { PasskeyError } from "../../../lib/react/passkey-error";
import { Button } from "../../../ui/button/button";
import {
  acceptTenantGroupInvitation,
  declineTenantGroupInvitation,
  tenantGroupInvitationsQuery,
} from "../api";

export function useOpsGroupInvitesItem() {
  const invQ = useQuery({ ...tenantGroupInvitationsQuery, retry: false });
  const items = invQ.data?.items ?? [];

  const acceptCmd = useCommand({
    run: (inv: { id: string; group_name: string }) => acceptTenantGroupInvitation(inv.id),
    invalidates: ["/api/v1/tenant/group-invitations", "/api/v1/users/me"],
    onSuccess: (_res, inv) => announce(t("account.opsSecurity.groupInviteAccepted", { group: inv.group_name })),
  });

  const declineCmd = useCommand({
    run: (id: string) => declineTenantGroupInvitation(id),
    invalidates: ["/api/v1/tenant/group-invitations"],
    onSuccess: () => announce(t("account.opsSecurity.groupInviteDeclined")),
  });

  if (items.length === 0) return null;

  return {
    key: "groupInvites",
    label: t("account.opsSecurity.groupInvites"),
    value: (
      <div className="form">
        {items.map((inv) => (
          <div key={inv.id} className="row">
            <bdi>
              {t("account.opsSecurity.groupInviteMeta", {
                group: inv.group_name,
                slug: inv.group_slug,
                at: fmtDateTime(inv.expires_at),
              })}
            </bdi>
            <Button
              size="sm"
              variant="primary"
              disabled={acceptCmd.isPending || declineCmd.isPending}
              onClick={() => acceptCmd.mutate({ id: inv.id, group_name: inv.group_name })}
            >
              {t("account.opsSecurity.groupInviteAccept")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={acceptCmd.isPending || declineCmd.isPending}
              onClick={() => declineCmd.mutate(inv.id)}
            >
              {t("account.opsSecurity.groupInviteDecline")}
            </Button>
          </div>
        ))}
        <PasskeyError error={acceptCmd.error ?? declineCmd.error} />
      </div>
    ),
  };
}

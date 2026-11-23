// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { ACCOUNT_STATUS, TENANT_STATUS, label } from "../../../lib/labels";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { EnumValue } from "../../../ui/enum-value";
import { RecordIdentityBar, RecordPaneSection } from "../../../ui/patterns/list-record-parts";
import {
  groupAccountsQuery,
  removeOrgFromGroup,
  revokeGroupRole,
  type Group,
  type GroupRole,
  type Issued,
  type Org,
  type Recorded,
} from "../api";
import { PLATFORM_GROUP_ROLE } from "../domain/tenants";
import { AssignOrgDialog, CreateGroupAccountDialog, GroupFormDialog } from "./group-dialogs";
import s from "./platform-console.module.css";

export function GroupConsolePanel({
  group,
  allOrgs,
  onRecorded,
  onIssued,
}: {
  group: Group;
  allOrgs: readonly Org[];
  onRecorded: (r: Recorded) => void;
  onIssued: (i: Issued) => void;
}) {
  const accountsQ = useQuery(groupAccountsQuery(group.id));
  const [editing, setEditing] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const [addingAccount, setAddingAccount] = useState(false);

  const removeOrg = useCommand({
    run: (member: { id: string; name: string }) => removeOrgFromGroup(group.id, member.id),
    invalidates: ["/api/platform"],
    onSuccess: (_res, member) => onRecorded({ message: t("tenants.groups.removeOrgDone", { org: member.name, group: group.name }) }),
  });

  const revokeRole = useCommand({
    run: (input: { userId: string; name: string; role: GroupRole }) => revokeGroupRole(group.id, input.userId, input.role),
    invalidates: ["/api/platform"],
    onSuccess: (_res, input) => onRecorded({ message: t("tenants.groups.revokeRoleDone", { name: input.name }) }),
  });

  const memberIds = new Set(group.members.map((m) => m.id));
  const assignableOrgs = allOrgs.filter((o) => !memberIds.has(o.id) && o.status === "ACTIVE");

  return (
    <div className={s.paneStack}>
      <RecordIdentityBar
        name={group.name}
        number={<code>{group.slug}</code>}
        badges={<EnumValue e={TENANT_STATUS} value={group.status} />}
        actions={
          <div className={s.actionRow}>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {t("tenants.groups.edit")}
            </Button>
          </div>
        }
      />

      <RecordPaneSection
        title={t("tenants.groups.members")}
        trailing={
          assignableOrgs.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => setAssigning(true)}>
              {t("tenants.groups.assignOrg")}
            </Button>
          ) : null
        }
      >
        <div className={s.paneStack}>
          <CommandError error={removeOrg.error} />
          {group.members.length === 0 ? (
            <bdi className="muted t-sm">{t("tenants.groups.membersEmpty")}</bdi>
          ) : (
            <div role="list" className={s.memberList}>
              {group.members.map((m) => (
                <div role="listitem" key={m.id} className={s.memberRow}>
                  <div className={s.memberMeta}>
                    <strong>{m.name}</strong>
                    <code>{m.slug}</code>
                    <EnumValue e={TENANT_STATUS} value={m.status} />
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={removeOrg.isPending}
                    onClick={() => removeOrg.mutate({ id: m.id, name: m.name })}
                  >
                    {t("tenants.groups.removeOrg")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </RecordPaneSection>

      <RecordPaneSection
        title={t("tenants.groups.accounts")}
        trailing={
          group.members.length > 0 ? (
            <Button size="sm" variant="secondary" onClick={() => setAddingAccount(true)}>
              {t("tenants.groups.createAccount")}
            </Button>
          ) : null
        }
      >
        <div className={s.paneStack}>
          <CommandError error={revokeRole.error} />
          <QueryState q={accountsQ} compact>
            {(accounts) =>
              accounts.length === 0 ? (
                <bdi className="muted t-sm">{t("tenants.groups.accountsEmpty")}</bdi>
              ) : (
                <div role="list" className={s.memberList}>
                  {accounts.map((acc) => (
                    <div role="listitem" key={acc.user_id} className={s.accountRow}>
                      <div className={s.memberRow}>
                        <div className={s.memberMeta}>
                          <strong>{acc.display_name}</strong>
                          <bdi className="muted t-xs">{acc.org_name}</bdi>
                        </div>
                        <EnumValue
                          e={ACCOUNT_STATUS}
                          value={acc.account_status === "DEACTIVATED" ? "ARCHIVED" : acc.account_status}
                        />
                      </div>
                      <div className={s.actionRow}>
                        {acc.group_roles.map((r) => (
                          <Chip key={r} tone="info">{label(PLATFORM_GROUP_ROLE, r)}</Chip>
                        ))}
                        {acc.group_roles.map((role) => (
                          <Button
                            key={`revoke-${role}`}
                            size="sm"
                            variant="secondary"
                            disabled={revokeRole.isPending}
                            onClick={() => revokeRole.mutate({ userId: acc.user_id, name: acc.display_name, role })}
                          >
                            {t("tenants.groups.revokeRole", { role: label(PLATFORM_GROUP_ROLE, role) })}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )
            }
          </QueryState>
        </div>
      </RecordPaneSection>

      <GroupFormDialog
        open={editing}
        group={group}
        onClose={() => setEditing(false)}
        onDone={(g) => {
          setEditing(false);
          onRecorded({ message: t("tenants.groups.updateDone", { name: g.name }) });
        }}
      />
      <AssignOrgDialog
        open={assigning}
        group={group}
        orgs={assignableOrgs}
        onClose={() => setAssigning(false)}
        onDone={(org) => {
          setAssigning(false);
          onRecorded({ message: t("tenants.groups.assignDone", { org: org.name, group: group.name }) });
        }}
      />
      <CreateGroupAccountDialog
        open={addingAccount}
        group={group}
        onClose={() => setAddingAccount(false)}
        onCreated={(res, orgName) => {
          setAddingAccount(false);
          onRecorded({ message: t("tenants.groups.accountDone", { name: res.account.display_name }) });
          onIssued({
            kind: "groupAccount",
            org: orgName,
            otp: res.otp,
            expiresAt: res.otp_expires_at,
          });
        }}
      />
    </div>
  );
}

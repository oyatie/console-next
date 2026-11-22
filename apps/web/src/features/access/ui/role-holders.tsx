// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { PersonLabel, PersonRef } from "../../../reference/person/ui/person-label";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { grantsQuery, type Account } from "../api";
import { grantPerson, periodText, storedScope } from "../present";
import { EnforcementChip } from "./enforcement-chip";
import { useOrgRoots } from "./use-org-roots";

/** Role holders tab: distinct account holders and their grant status over grantsQuery({ role_id }). */
export function RoleHolders({ roleId, roleName, accounts }: { roleId: string; roleName: string; accounts: readonly Account[] }) {
  const grants = useQuery(grantsQuery({ role_id: roleId }));
  const roots = useOrgRoots();
  const distinct = [...new Map((grants.data?.items ?? []).map((g) => [g.account_id, g])).values()];
  const count = distinct.length;
  return (
    <Card
      title={t("accessGrants.holders", { role: roleName, count })}
      tools={<Link to="/access/grants" search={{ role: roleId }}>{t("access.nav.grants")}</Link>}
      flush
    >
      <QueryState q={grants} layout="list">
        {({ items }) => {
          const holders = [...new Map(items.map((g) => [g.account_id, g])).values()];
          return holders.length ? (
            <Table
              label={t("access.roles.col.holders")}
              rows={holders}
              rowId={(g) => g.account_id}
              columns={[
                {
                  card: "title",
                  rowHeader: true,
                  header: t("access.col.person"),
                  cell: (g) => {
                    const account = accounts.find((a) => a.id === g.account_id);
                    return (
                      <>
                        <Link to="/access/people/$accountId" params={{ accountId: g.account_id }}>
                          <PersonLabel person={grantPerson(g, accounts)} peers={accounts} linked={false} wrap />
                        </Link>{" "}
                        {account && <PersonRef account={account} details={false} wrap />}
                      </>
                    );
                  },
                },
                { card: "fact", header: t("access.col.scope"), cell: (g) => storedScope(g.scope, roots) },
                { card: "fact", header: t("access.col.until"), fit: true, cell: (g) => periodText(g) },
                { card: "fact", header: t("access.col.passkey"), fit: true, cell: (g) => t(g.account_has_passkey ? "accessGrants.passkey.yes" : "accessGrants.passkey.no") },
                { card: "status", header: t("access.col.state"), fit: true, cell: (g) => <EnforcementChip e={g.account_active ? g.enforcement : "ACCOUNT_INACTIVE"} /> },
              ]}
            />
          ) : (
            <EmptyState title={t("access.role.effect.none")} reason={null} />
          );
        }}
      </QueryState>
    </Card>
  );
}

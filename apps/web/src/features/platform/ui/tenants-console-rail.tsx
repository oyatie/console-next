// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { FilterRail } from "../../../ui/filter-rail/filter-rail";
import type { Group, Org, OrgStatus } from "../api";
import { LIFECYCLES, type TenantLifecycle } from "../domain/tenants";

export function TenantsConsoleRail({
  all,
  groups,
  statuses,
  lifecycles,
  groupFilter,
  activeFilterCount,
  hasQuery,
  phoneTools,
  onToggleStatus,
  onToggleLifecycle,
  onSelectGroup,
  onReset,
}: {
  all: readonly Org[];
  groups: readonly Group[];
  statuses: ReadonlySet<OrgStatus>;
  lifecycles: ReadonlySet<TenantLifecycle>;
  groupFilter: string | null;
  activeFilterCount: number;
  hasQuery: boolean;
  phoneTools: ReactNode;
  onToggleStatus: (status: OrgStatus) => void;
  onToggleLifecycle: (lifecycle: TenantLifecycle) => void;
  onSelectGroup: (groupId: string | null) => void;
  onReset: () => void;
}) {
  return (
    <FilterRail
      label={t("tenants.rail.label")}
      toggleLabel={t("tenants.rail.toggle")}
      activeCount={activeFilterCount}
      phoneTools={phoneTools}
      groups={[
        {
          id: "status",
          title: t("tenants.col.status"),
          items: (["ACTIVE", "SUSPENDED", "ARCHIVED"] as const).map((st) => ({
            id: st,
            label: t(`enum.tenantStatus.${st}`),
            checked: statuses.has(st),
            count: all.filter((o) => o.status === st).length,
            onChange: () => onToggleStatus(st),
          })),
        },
        {
          id: "lifecycle",
          title: t("tenants.rail.lifecycle"),
          items: LIFECYCLES.map((lc) => ({
            id: lc,
            label: t(`enum.tenantLifecycle.${lc}`),
            checked: lifecycles.has(lc),
            count: all.filter((o) => o.lifecycle === lc).length,
            onChange: () => onToggleLifecycle(lc),
          })),
        },
        ...(groups.length > 0
          ? [
              {
                id: "group",
                title: t("tenants.rail.group"),
                items: [
                  ...groups.map((g) => ({
                    id: g.id,
                    label: g.name,
                    checked: groupFilter === g.id,
                    count: all.filter((o) => o.group_id === g.id).length,
                    onChange: (checked: boolean) => onSelectGroup(checked ? g.id : null),
                  })),
                  {
                    id: "__none__",
                    label: t("tenants.rail.unassigned"),
                    checked: groupFilter === "__none__",
                    count: all.filter((o) => o.group_id === null).length,
                    onChange: (checked: boolean) => onSelectGroup(checked ? "__none__" : null),
                  },
                ],
              },
            ]
          : []),
      ]}
      reset={{ label: t("tenants.rail.reset"), disabled: activeFilterCount === 0 && !hasQuery, onReset }}
    />
  );
}

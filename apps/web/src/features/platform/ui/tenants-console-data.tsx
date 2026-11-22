// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { TENANT_LIFECYCLE, TENANT_STATUS } from "../../../lib/labels";
import { EnumValue } from "../../../ui/enum-value";
import type { Column } from "../../../ui/table";
import type { Health, Org, OrgStatus } from "../api";
import type { View } from "../domain/tenants";
import s from "./platform-console.module.css";

export const statusesForView = (view?: View | "all"): Set<OrgStatus> =>
  view === "suspended" ? new Set(["SUSPENDED"]) : view === "archived" ? new Set(["ARCHIVED"]) : new Set();

export const viewForStatuses = (statuses: ReadonlySet<OrgStatus>): Exclude<View, "active"> | undefined =>
  statuses.size === 1 && statuses.has("SUSPENDED")
    ? "suspended"
    : statuses.size === 1 && statuses.has("ARCHIVED")
      ? "archived"
      : undefined;

export function buildTenantColumns(health: ReadonlyMap<string, Health>): Column<Org>[] {
  return [
    {
      header: t("tenants.col.name"),
      card: "title",
      cell: (o) => (
        <div className={s.cellGroup}>
          <strong title={o.name}>{o.name}</strong>
          {o.group_name ? <bdi className="muted t-xs">{o.group_name}</bdi> : null}
        </div>
      ),
    },
    { header: t("tenants.col.slug"), card: "fact", cell: (o) => <code className={s.nowrap}>{o.slug}</code> },
    {
      header: t("tenants.col.status"),
      card: "status",
      fit: true,
      cell: (o) => (
        <div className={s.inlineBadges}>
          <EnumValue e={TENANT_STATUS} value={o.status} />
          {o.lifecycle ? <EnumValue e={TENANT_LIFECYCLE} value={o.lifecycle} /> : null}
        </div>
      ),
    },
    {
      header: t("tenants.col.users"),
      card: "omit",
      fit: true,
      cell: (o) => (
        <bdi className={`num ${s.nowrap}`}>
          {o.passkey_registered_count !== undefined
            ? `${fmtNumber(o.passkey_registered_count)} / ${fmtNumber(o.code_issued_count ?? 0)}`
            : "—"}
        </bdi>
      ),
    },
    {
      header: t("tenants.col.activity"),
      card: "omit",
      wide: true,
      fit: true,
      cell: (o) => <bdi className={`num ${s.nowrap}`}>{fmtDate(health.get(o.id)?.last_activity_at)}</bdi>,
    },
    {
      header: t("tenants.col.created"),
      card: "omit",
      wide: true,
      fit: true,
      cell: (o) => <bdi className={`num ${s.nowrap}`}>{fmtDate(o.created_at)}</bdi>,
    },
  ];
}

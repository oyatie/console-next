// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { TENANT_STATUS } from "../../../lib/labels";
import { Button } from "../../../ui/button/button";
import { EmptyState } from "../../../ui/empty-state";
import { EnumValue } from "../../../ui/enum-value";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { rowById } from "../../../ui/long-table/row-keys";
import { ListRecord } from "../../../ui/patterns/list-record";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table } from "../../../ui/table";
import { groupsQuery, tenantsQuery, type Group, type Issued, type OrgStatus, type Recorded } from "../api";
import { CodeDialog } from "./code-dialog";
import { GroupConsolePanel } from "./group-console-panel";
import { GroupFormDialog } from "./group-dialogs";
import { useDesktopAutoSelect } from "./use-desktop-auto-select";
import s from "./platform-console.module.css";

const mobileMemberLabel = (count: number) => ` · ${t("tenants.groups.memberCount", { count })}`;

export function GroupsConsole({ tabs }: { tabs: ReactNode }) {
  const groupsQ = useQuery(groupsQuery);
  const orgsQ = useQuery(tenantsQuery);
  const [selectedId, setSelectedId] = useState<string>();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<OrgStatus | null>(null);
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [full, setFull] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => groupsQ.data ?? [], [groupsQ.data]);
  const allOrgs = useMemo(() => (orgsQ.data ?? []).filter((o) => o.slug !== "platform"), [orgsQ.data]);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter((g) => {
      if (statusFilter && g.status !== statusFilter) return false;
      if (!n) return true;
      return g.name.toLowerCase().includes(n) || g.slug.toLowerCase().includes(n);
    });
  }, [all, q, statusFilter]);

  const { effectiveId, select, dismiss } = useDesktopAutoSelect({
    rows,
    getId: (g) => g.id,
    explicitId: selectedId,
    onSelectExplicit: setSelectedId,
    onClearExplicit: () => setSelectedId(undefined),
  });
  const empty = groupsQ.data !== undefined && all.length === 0;
  const selected = all.find((g) => g.id === effectiveId);
  const statItems: StatRowItem[] = [
    { key: "all", label: t("tenants.view.all"), value: fmtNumber(all.length), active: statusFilter === null, onPress: () => setStatusFilter(null) },
    { key: "active", label: t("tenants.view.active"), value: fmtNumber(all.filter((g) => g.status === "ACTIVE").length), tone: "ok", active: statusFilter === "ACTIVE", onPress: () => setStatusFilter("ACTIVE") },
    { key: "suspended", label: t("tenants.view.suspended"), value: fmtNumber(all.filter((g) => g.status === "SUSPENDED").length), tone: "warn", active: statusFilter === "SUSPENDED", onPress: () => setStatusFilter("SUSPENDED") },
    { key: "archived", label: t("tenants.view.archived"), value: fmtNumber(all.filter((g) => g.status === "ARCHIVED").length), tone: "muted", active: statusFilter === "ARCHIVED", onPress: () => setStatusFilter("ARCHIVED") },
  ];

  return (
    <ListRecord
      tabs={tabs}
      q={groupsQ}
      head={{
        title: t("tenants.groups.title"),
        titleId: "groups-title",
        primary: empty ? undefined : { id: "create-group", label: t("tenants.groups.create"), onAction: () => setCreating(true) },
      }}
      find={
        all.length > 0 ? (
          <div className={s.findWrap} data-list-find="">
            <WorklistSearchField label={t("tenants.groups.search")} value={q} onChange={setQ} />
          </div>
        ) : undefined
      }
      stats={all.length > 0 ? <StatRow label={t("tenants.groups.title")} items={statItems} /> : undefined}
      notes={recorded ? <Receipt state="recorded" message={recorded.message} meta={recorded.meta} /> : undefined}
      list={
        <div ref={tableRef} id="groups-list" className={s.tableWrap}>
          {all.length === 0 ? (
            <EmptyState
              title={t("tenants.groups.empty.title")}
              reason={t("tenants.groups.empty.reason")}
              actions={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  {t("tenants.groups.create")}
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={t("tenants.view.empty")}
              reason={t("tenants.view.emptyReason")}
              actions={<Button onClick={() => { setQ(""); setStatusFilter(null); }}>{t("tenants.rail.reset")}</Button>}
            />
          ) : (
            <Table
              label={t("tenants.groups.title")}
              rows={rows}
              rowId={(g: Group) => g.id}
              selected={effectiveId}
              onSelect={select}
              mobileLayout="compact"
              density="compact"
              columns={[
                {
                  header: t("tenants.groups.col.name"),
                  card: "title",
                  cell: (g) => (
                    <bdi>
                      <strong>{g.name}</strong>
                      <bdi className={s.mobileOnly}>{mobileMemberLabel(g.member_count)}</bdi>
                    </bdi>
                  ),
                },
                { header: t("tenants.groups.col.slug"), card: "fact", fit: true, cell: (g) => <code className={s.nowrap}>{g.slug}</code> },
                {
                  header: t("tenants.groups.col.status"),
                  card: "status",
                  fit: true,
                  cell: (g) => <EnumValue e={TENANT_STATUS} value={g.status} />,
                },
                { header: t("tenants.groups.col.members"), card: "omit", fit: true, cell: (g) => <bdi className="num">{fmtNumber(g.member_count)}</bdi> },
                { header: t("tenants.col.created"), card: "omit", wide: true, fit: true, cell: (g) => <bdi className={`num ${s.nowrap}`}>{fmtDate(g.created_at)}</bdi> },
              ]}
            />
          )}
        </div>
      }
      full={full}
      onFull={setFull}
      onSelect={select}
      record={
        selected
          ? {
              id: selected.id,
              label: selected.name,
              title: selected.name,
              meta: selected.slug,
              onClose: dismiss,
              returnFocus: () => rowById(tableRef.current, selected.id),
              children: (
                <GroupConsolePanel
                  key={selected.id}
                  group={selected}
                  allOrgs={allOrgs}
                  onRecorded={setRecorded}
                  onIssued={setIssued}
                />
              ),
            }
          : null
      }
      statusSegments={
        groupsQ.data
          ? [
              { id: "scope", content: t("shell.hub.platform"), tone: "strong" },
              { id: "tab", content: t("tenants.tab.groups") },
              { id: "count", content: t("tenants.status.count", { shown: rows.length, total: all.length }) },
              ...(selected ? [{ id: "sel", content: selected.name }] : []),
            ]
          : null
      }
      overlays={
        <>
          <GroupFormDialog
            open={creating}
            onClose={() => setCreating(false)}
            onDone={(g) => {
              setCreating(false);
              select(g.id);
              setRecorded({ message: t("tenants.groups.createDone", { name: g.name }) });
            }}
          />
          <CodeDialog issued={issued} onClose={() => setIssued(null)} />
        </>
      }
    />
  );
}

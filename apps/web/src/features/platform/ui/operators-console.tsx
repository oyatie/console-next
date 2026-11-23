// SPDX-License-Identifier: LicenseRef-Proprietary
import { useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate, fmtNumber } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { EnumValue } from "../../../ui/enum-value";
import { StatRow, type StatRowItem } from "../../../ui/key-value/key-value";
import { rowById } from "../../../ui/long-table/row-keys";
import { ListRecord } from "../../../ui/patterns/list-record";
import { WorklistSearchField } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table } from "../../../ui/table";
import { operatorId, operatorsQuery, type Issued, type OperatorSummary, type Recorded } from "../api";
import { PLATFORM_OPERATOR_STATUS, operatorStats } from "../domain/operators";
import { CodeDialog } from "./code-dialog";
import { InviteOperatorDialog, OperatorConsolePanel } from "./operator-console-panel";
import { useDesktopAutoSelect } from "./use-desktop-auto-select";
import s from "./platform-console.module.css";

export function OperatorsConsole({ tabs }: { tabs: ReactNode }) {
  const opsQ = useQuery(operatorsQuery);
  const [selectedId, setSelectedId] = useState<string>();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "pending" | "revoked">("all");
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [full, setFull] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);

  const all = useMemo(() => opsQ.data ?? [], [opsQ.data]);
  const counts = useMemo(() => operatorStats(all), [all]);
  const rows = useMemo(() => {
    const n = q.trim().toLowerCase();
    return all.filter((op) => {
      if (statusFilter === "active" && !(op.status === "ACTIVE" && op.has_passkey)) return false;
      if (statusFilter === "pending" && op.status !== "PENDING_ENROLMENT" && op.status !== "EXPIRED") return false;
      if (statusFilter === "revoked" && op.status !== "REVOKED") return false;
      if (!n) return true;
      return op.display_name.toLowerCase().includes(n) || (op.sign_in_id ?? "").toLowerCase().includes(n);
    });
  }, [all, q, statusFilter]);

  const { effectiveId, select, dismiss } = useDesktopAutoSelect({
    rows,
    getId: (op) => op.user_id,
    explicitId: selectedId,
    onSelectExplicit: setSelectedId,
    onClearExplicit: () => setSelectedId(undefined),
  });
  const empty = opsQ.data !== undefined && all.length === 0;
  const selected = all.find((op) => op.user_id === effectiveId);
  const me = operatorId();

  const statItems: StatRowItem[] = [
    { key: "all", label: t("tenants.operators.stat.all"), value: fmtNumber(counts.all), active: statusFilter === "all", onPress: () => setStatusFilter("all") },
    { key: "active", label: t("tenants.operators.stat.active"), value: fmtNumber(counts.active), tone: "ok", active: statusFilter === "active", onPress: () => setStatusFilter("active") },
    { key: "pending", label: t("tenants.operators.stat.pending"), value: fmtNumber(counts.pending), tone: counts.pending > 0 ? "warn" : "muted", active: statusFilter === "pending", onPress: () => setStatusFilter("pending") },
    { key: "revoked", label: t("tenants.operators.stat.revoked"), value: fmtNumber(counts.revoked), tone: "muted", active: statusFilter === "revoked", onPress: () => setStatusFilter("revoked") },
  ];

  return (
    <ListRecord
      tabs={tabs}
      q={opsQ}
      head={{
        title: t("tenants.operators.title"),
        titleId: "operators-title",
        primary: empty ? undefined : { id: "invite-operator", label: t("tenants.operators.invite"), onAction: () => setInviting(true) },
      }}
      find={
        all.length > 0 ? (
          <div className={s.findWrap} data-list-find="">
            <WorklistSearchField label={t("tenants.operators.search")} value={q} onChange={setQ} />
          </div>
        ) : undefined
      }
      stats={all.length > 0 ? <StatRow label={t("tenants.operators.stat.label")} items={statItems} /> : undefined}
      notes={recorded ? <Receipt state="recorded" message={recorded.message} meta={recorded.meta} /> : undefined}
      list={
        <div ref={tableRef} id="operators-list" className={s.tableWrap}>
          {all.length === 0 ? (
            <EmptyState
              title={t("tenants.operators.empty.title")}
              reason={t("tenants.operators.empty.reason")}
              actions={
                <Button variant="primary" onClick={() => setInviting(true)}>
                  {t("tenants.operators.invite")}
                </Button>
              }
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title={t("tenants.view.empty")}
              reason={t("tenants.view.emptyReason")}
              actions={<Button onClick={() => { setQ(""); setStatusFilter("all"); }}>{t("tenants.rail.reset")}</Button>}
            />
          ) : (
            <Table
              label={t("tenants.operators.title")}
              rows={rows}
              rowId={(op: OperatorSummary) => op.user_id}
              selected={effectiveId}
              onSelect={select}
              mobileLayout="compact"
              density="compact"
              columns={[
                { header: t("tenants.operators.col.name"), card: "title", cell: (op) => <strong>{op.display_name}</strong> },
                { header: t("tenants.operators.col.login"), card: "fact", cell: (op) => <code className={s.loginCell}>{op.sign_in_id ?? "—"}</code> },
                {
                  header: t("tenants.operators.col.status"),
                  card: "status",
                  fit: true,
                  cell: (op) => <EnumValue e={PLATFORM_OPERATOR_STATUS} value={op.status} />,
                },
                {
                  header: t("tenants.operators.col.passkey"),
                  card: "omit",
                  fit: true,
                  cell: (op) => (
                    <Chip tone={op.device_bound_passkey ? "ok" : op.has_passkey ? "info" : "neutral"}>
                      {t(
                        op.device_bound_passkey
                          ? "tenants.operators.passkey.bound"
                          : op.has_passkey
                            ? "tenants.operators.passkey.enrolled"
                            : "tenants.operators.passkey.none",
                      )}
                    </Chip>
                  ),
                },
                {
                  header: t("tenants.operators.col.expires"),
                  card: "omit",
                  wide: true,
                  fit: true,
                  cell: (op) => <bdi className={`num ${s.nowrap}`}>{op.invite_expires_at ? fmtDate(op.invite_expires_at) : "—"}</bdi>,
                },
                {
                  header: t("tenants.col.created"),
                  card: "omit",
                  wide: true,
                  fit: true,
                  cell: (op) => <bdi className={`num ${s.nowrap}`}>{fmtDate(op.created_at)}</bdi>,
                },
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
              id: selected.user_id,
              label: selected.display_name,
              title: selected.display_name,
              meta: selected.sign_in_id ?? undefined,
              onClose: dismiss,
              returnFocus: () => rowById(tableRef.current, selected.user_id),
              children: (
                <OperatorConsolePanel
                  key={selected.user_id}
                  op={selected}
                  all={all}
                  currentUserId={me}
                  onIssued={(i, receipt) => {
                    setIssued(i);
                    setRecorded(receipt);
                  }}
                  onRevoked={(receipt) => setRecorded(receipt)}
                />
              ),
            }
          : null
      }
      statusSegments={
        opsQ.data
          ? [
              { id: "scope", content: t("shell.hub.platform"), tone: "strong" },
              { id: "tab", content: t("tenants.tab.operators") },
              { id: "count", content: t("tenants.status.count", { shown: rows.length, total: all.length }) },
              ...(selected ? [{ id: "sel", content: selected.display_name }] : []),
            ]
          : null
      }
      overlays={
        <>
          <InviteOperatorDialog
            open={inviting}
            onClose={() => setInviting(false)}
            onInvited={(res) => {
              setInviting(false);
              select(res.operator.user_id);
              setRecorded({ message: t("tenants.operators.inviteDone", { name: res.operator.display_name }) });
              setIssued({
                kind: "operator",
                org: res.operator.display_name,
                otp: res.invite_token,
                expiresAt: res.expires_at,
                signInId: res.operator.sign_in_id,
              });
            }}
          />
          <CodeDialog issued={issued} onClose={() => setIssued(null)} />
        </>
      }
    />
  );
}

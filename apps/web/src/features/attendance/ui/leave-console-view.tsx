// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { myAccessQuery } from "../../../reference/authz/api";
import { accessRefusal } from "../../../reference/authz/domain/access";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Field } from "../../../ui/field/field";
import { SelectInput } from "../../../ui/field/select-input";
import { KeyValue, StatRow } from "../../../ui/key-value/key-value";
import { RegisterTotals } from "../../../ui/patterns/register-totals";
import { RegisterToolbarSearch } from "../../../ui/patterns/register-totals-parts";
import { WorklistPadded, WorklistSearchField, WorklistSegmentBar } from "../../../ui/patterns/worklist-parts";
import { Receipt } from "../../../ui/receipt/receipt";
import { Table } from "../../../ui/table";
import {
  branchesQuery,
  directoryPeopleQuery,
  leaveBalancesQuery,
  pushLeavePromotion,
  pushLeaveRefusalNotice,
  type LeaveRosterEntry,
} from "../api/leave-admin";
import { AttendanceTabNav } from "./attendance-head";
import { useAttendancePhaseLine } from "./use-attendance-phase-line";
import s from "./attendance-console.module.css";

type FilterMode = "all" | "promote";

export function LeaveConsoleView({ baseline }: { baseline: () => ReactNode }) {
  const access = useQuery(myAccessQuery);
  const canManage = Boolean(access.data && accessRefusal(access.data, { domain: "hr_basic", level: "edit" }) === null);
  const canReadDirectory = Boolean(access.data && accessRefusal(access.data, { domain: "hr_basic", level: "view" }) === null);
  const q = useQuery(leaveBalancesQuery);
  const branches = useQuery({ ...branchesQuery, enabled: canManage });
  const directory = useQuery({ ...directoryPeopleQuery, enabled: canManage && canReadDirectory });
  const phaseLine = useAttendancePhaseLine();

  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [branchId, setBranchId] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);

  const items = q.data?.items ?? [];
  const promoteCount = items.filter((r) => r.tone === "promote").length;
  const totalGrant = items.reduce((acc, r) => acc + r.grant, 0);
  const totalUsed = items.reduce((acc, r) => acc + r.used, 0);
  const totalLeft = items.reduce((acc, r) => acc + r.left, 0);

  const trimmed = search.trim().toLowerCase();
  const visible = items.filter((r) => {
    if (filter === "promote" && r.tone !== "promote") return false;
    if (!trimmed) return true;
    return r.name.toLowerCase().includes(trimmed) || (r.team ?? "").toLowerCase().includes(trimmed);
  });

  const selected: LeaveRosterEntry | null = visible.find((r) => r.employee_id === selectedId) ?? visible[0] ?? null;
  const branchOptions = branches.data ?? [];
  const effectiveBranchId = branchId || branchOptions[0]?.id || "";
  const matchedPerson = directory.data?.items.find((p) => p.employee_id === selected?.employee_id);
  const targetUserId = matchedPerson?.id ?? "";

  const promoteCmd = useCommand({
    run: ({ entry, round }: { entry: LeaveRosterEntry; round: 1 | 2 }) =>
      pushLeavePromotion({
        branch_id: effectiveBranchId,
        target_user_id: targetUserId,
        target_employee_id: entry.employee_id,
        target_name: entry.name,
        round,
        unused_days: entry.left,
      }),
    invalidates: ["/api/v1/leave/balances"],
    announce: (_, vars) => t("attendance.leave.sentPromotion", { name: vars.entry.name, round: vars.round }),
    onSuccess: (_, vars) => setReceipt(t("attendance.leave.sentPromotion", { name: vars.entry.name, round: vars.round })),
  });

  const refusalCmd = useCommand({
    run: (entry: LeaveRosterEntry) =>
      pushLeaveRefusalNotice({
        branch_id: effectiveBranchId,
        target_user_id: targetUserId,
        target_employee_id: entry.employee_id,
        target_name: entry.name,
        unused_days: entry.left,
      }),
    invalidates: ["/api/v1/leave/balances"],
    announce: (_, entry) => t("attendance.leave.sentRefusal", { name: entry.name }),
    onSuccess: (_, entry) => setReceipt(t("attendance.leave.sentRefusal", { name: entry.name })),
  });

  const canSend = Boolean(canManage && selected && effectiveBranchId && targetUserId);
  const cmdError = promoteCmd.error ?? refusalCmd.error;

  return (
    <RegisterTotals
      q={q}
      baseline={baseline}
      tabs={<AttendanceTabNav tab="leave" />}
      head={{
        title: t("attendance.title"),
        titleId: "attendance-leave-title",
        meta: phaseLine,
        filters: (
          <>
            <WorklistSegmentBar
              label={t("attendance.leave.title")}
              value={filter}
              onChange={setFilter}
              items={[
                { id: "all", label: t("attendance.leave.filterAll"), count: fmtNumber(items.length) },
                { id: "promote", label: t("attendance.leave.filterPromote"), count: fmtNumber(promoteCount), tone: promoteCount > 0 ? "warn" : undefined },
              ]}
            />
            <RegisterToolbarSearch>
              <WorklistSearchField label={t("attendance.leave.searchPlaceholder")} value={search} onChange={setSearch} />
            </RegisterToolbarSearch>
          </>
        ),
      }}
      totals={
        <StatRow
          label={t("attendance.leave.title")}
          items={[
            { key: "emp", label: t("attendance.leave.statEmployees"), value: fmtNumber(items.length) },
            { key: "grant", label: t("attendance.leave.statGrant"), value: t("attendance.leave.days", { days: totalGrant }) },
            { key: "used", label: t("attendance.leave.statUsed"), value: t("attendance.leave.days", { days: totalUsed }) },
            { key: "left", label: t("attendance.leave.statLeft"), value: t("attendance.leave.days", { days: totalLeft }) },
          ]}
        />
      }
      blockers={
        <>
          {receipt && <Receipt state="recorded" message={receipt} />}
          {cmdError && <CommandError error={cmdError} />}
        </>
      }
      register={
        visible.length === 0 ? (
          <EmptyState title={t("attendance.leave.emptyTitle")} reason={null} />
        ) : (
          <Table
            label={t("attendance.tab.leave")}
            rows={visible}
            rowId={(r) => r.employee_id}
            selected={selected?.employee_id}
            onSelect={setSelectedId}
            columns={[
              { header: t("attendance.leave.colName"), card: "title", cell: (r) => r.name },
              { header: t("attendance.leave.colTeam"), card: "fact", cell: (r) => r.team ?? "—" },
              { header: t("attendance.leave.colGrant"), cell: (r) => <span className="num">{t("attendance.leave.days", { days: r.grant })}</span> },
              { header: t("attendance.leave.colUsed"), cell: (r) => <span className="num">{t("attendance.leave.days", { days: r.used })}</span> },
              { header: t("attendance.leave.colLeft"), cell: (r) => <span className="num">{t("attendance.leave.days", { days: r.left })}</span> },
              {
                header: t("attendance.leave.colStatus"),
                fit: true,
                cell: (r) => (
                  <Chip tone={r.tone === "promote" ? "warn" : r.tone === "low" ? "info" : "ok"}>
                    {t(`attendance.leave.tone.${r.tone}`)}
                  </Chip>
                ),
              },
            ]}
          />
        )
      }
      record={
        selected
          ? {
              id: "leave-pane",
              label: t("attendance.leave.paneTitle"),
              title: selected.name,
              onClose: () => setSelectedId(null),
              children: (
                <Card title={t("attendance.leave.paneTitle")}>
                  <WorklistPadded>
                    <div className="form">
                      <KeyValue
                        readOnly
                        items={[
                          { key: "grant", label: t("attendance.leave.colGrant"), value: t("attendance.leave.days", { days: selected.grant }) },
                          { key: "used", label: t("attendance.leave.colUsed"), value: t("attendance.leave.days", { days: selected.used }) },
                          { key: "left", label: t("attendance.leave.colLeft"), value: t("attendance.leave.days", { days: selected.left }) },
                        ]}
                      />
                      {canManage && branchOptions.length > 0 && (
                        <Field label={t("attendance.leave.branchLabel")} required={false}>
                          {(p) => (
                            <SelectInput {...p} value={effectiveBranchId} onChange={(e) => setBranchId(e.target.value)}>
                              {branchOptions.map((wp) => (
                                <option key={wp.id} value={wp.id}>
                                  {wp.name}
                                </option>
                              ))}
                            </SelectInput>
                          )}
                        </Field>
                      )}
                      {canManage && (
                        <div className={s.headActions}>
                          <Button size="sm" variant="primary" disabled={!canSend || promoteCmd.isPending} onClick={() => promoteCmd.mutate({ entry: selected, round: 1 })}>
                            {t("attendance.leave.promoteRound1")}
                          </Button>
                          <Button size="sm" variant="secondary" disabled={!canSend || promoteCmd.isPending} onClick={() => promoteCmd.mutate({ entry: selected, round: 2 })}>
                            {t("attendance.leave.promoteRound2")}
                          </Button>
                          <Button size="sm" variant="ghost" disabled={!canSend || refusalCmd.isPending} onClick={() => refusalCmd.mutate(selected)}>
                            {t("attendance.leave.refusalNotice")}
                          </Button>
                        </div>
                      )}
                      {canManage && !canSend && <p className="muted">{t("attendance.leave.selectAccountHint")}</p>}
                    </div>
                  </WorklistPadded>
                </Card>
              ),
            }
          : null
      }
    />
  );
}

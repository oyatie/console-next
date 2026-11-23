// SPDX-License-Identifier: LicenseRef-Proprietary
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { COPY } from "../copy";
import { fetchOpsRecovery, OpsApiError, opsQueryKeys, type OpsCmdHandOff, type OpsRecoveryView } from "../lib/api";
import { classifyOpsError, hasOpsAction } from "../lib/auth";
import { fmtColon, formatDuration, formatUtcShort, formatUtcTimestamp } from "../lib/format";
import { useRecoveryBackupMutation, useRecoveryDrillMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { buildDrillRequest } from "../lib/validation";
import { CmdReceipt } from "../ui/cmd-receipt";
import { CompactTable, type TableColumn } from "../ui/compact-table";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import { O0State } from "../ui/o0-state";
import { ObservedValue } from "../ui/observed-value";
import { PageHead } from "../ui/page-head";
import { SelectField } from "../ui/select-field";
import { StatRow } from "../ui/stat-row";
import s from "./recovery-screen.module.css";

type RepoRow = OpsRecoveryView["repos"][number];

const BACKUP_TYPE_OPTIONS = [
  { value: "incr", label: "Incremental" },
  { value: "diff", label: "Differential" },
  { value: "full", label: "Full" },
] as const;

const WINDOW_OPTIONS = [
  { value: "window", label: "Maintenance window" },
  { value: "now", label: "Run now" },
] as const;

const REPO_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "1", label: "Repo 1" },
  { value: "2", label: "Repo 2" },
] as const;

const DRILL_TYPE_OPTIONS = [
  { value: "name", label: "By name" },
  { value: "time", label: "By time (UTC Z)" },
] as const;

export function RecoveryScreen() {
  const { me, live, reportEvaluatedAt } = useOpsContext();
  const allowed = hasOpsAction(me, "recovery.read");
  const canBackup = hasOpsAction(me, "change.request.backup-now");
  const canDrillName = hasOpsAction(me, "change.request.drill");
  const canDrillTime = hasOpsAction(me, "change.request.drill-at");

  const backupMut = useRecoveryBackupMutation();
  const drillMut = useRecoveryDrillMutation();

  const [backupType, setBackupType] = useState<"full" | "diff" | "incr">("incr");
  const [backupWindow, setBackupWindow] = useState<"window" | "now">("window");
  const [drillRepo, setDrillRepo] = useState<"1" | "2" | "auto">("auto");
  const [drillType, setDrillType] = useState<"name" | "time">("name");
  const [drillTarget, setDrillTarget] = useState("");
  const [drillWindow, setDrillWindow] = useState<"window" | "now">("window");
  const [drillValidation, setDrillValidation] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<OpsCmdHandOff | null>(null);

  const query = useQuery({
    queryKey: opsQueryKeys.recovery,
    queryFn: fetchOpsRecovery,
    enabled: allowed,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.data?.evaluated_at) reportEvaluatedAt(query.data.evaluated_at);
  }, [query.data?.evaluated_at, reportEvaluatedAt]);

  if (!allowed) {
    return (
      <O0State
        model={classifyOpsError(
          new OpsApiError(403, {
            code: "OPS_ACTION_DENIED",
            message: "Recovery view requires recovery.read permission.",
            support_ref: "cedar-recovery",
            evaluated_at: me.evaluated_at,
          }),
        )}
      />
    );
  }

  if (query.isPending) {
    return <div className={s.page}><PageHead title={COPY.recovery.title} meta={COPY.loading.recoveryTitle} /></div>;
  }

  if (query.isError || !query.data) {
    return <O0State model={classifyOpsError(query.error)} onRetry={() => void query.refetch()} />;
  }

  const data = query.data;
  const canDrill = drillType === "time" ? canDrillTime : canDrillName;

  const cols: readonly TableColumn<RepoRow>[] = [
    { id: "repo", header: COPY.recovery.cols.repo, mobileSlot: "title", render: (r) => r.repository },
    { id: "rpo", header: COPY.recovery.cols.rpo, mobileSlot: "badge", nowrap: true, render: (r) => <ObservedValue observation={r.rpo_s} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatDuration(Number(v))} /> },
    { id: "limit", header: COPY.recovery.cols.limit, nowrap: true, render: (r) => <ObservedValue observation={r.limit_s} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatDuration(Number(v))} /> },
    { id: "lastBase", header: COPY.recovery.cols.lastBase, mobileSlot: "meta", nowrap: true, render: (r) => <ObservedValue observation={r.last_base_backup} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatUtcShort(String(v))} /> },
    { id: "pushFailures", header: COPY.recovery.cols.pushFailures, nowrap: true, align: "right", render: (r) => <ObservedValue observation={r.push_failures} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} /> },
  ];

  return (
    <div className={s.page}>
      <PageHead
        title={COPY.recovery.title}
        meta={<span className={s.metaText}>{fmtColon(COPY.status.evaluatedAt, formatUtcTimestamp(data.evaluated_at))}</span>}
      />

      <StatRow
        items={[
          { id: "rto", label: COPY.recovery.rtoLabel, value: <ObservedValue observation={data.rto} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} /> },
          { id: "deferred", label: COPY.recovery.deferredLabel, value: <ObservedValue observation={data.deferred_since} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatUtcShort(String(v))} /> },
          { id: "exit", label: COPY.recovery.lastExitLabel, value: <ObservedValue observation={data.last_exit_code} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} /> },
          { id: "lvm", label: COPY.recovery.lvmLabel, value: <ObservedValue observation={data.lvm_snapshot_at} liveStatus={live.status} disconnectedAgeS={live.disconnectedAgeS} formatValue={(v) => formatUtcShort(String(v))} /> },
          {
            id: "mount",
            label: COPY.recovery.mountLabel,
            value: (
              <ObservedValue
                observation={data.onprem_mount_expected}
                liveStatus={live.status}
                disconnectedAgeS={live.disconnectedAgeS}
                asBadge
                formatValue={(v) => (v ? COPY.recovery.expectedYes : COPY.recovery.expectedNo)}
              />
            ),
          },
        ]}
      />

      <section className={s.band} aria-labelledby="recovery-repos">
        <div className={s.bandHead}><h2 id="recovery-repos" className={s.bandTitle}>{COPY.recovery.reposTitle}</h2></div>
        {data.repos.length > 0 ? (
          <CompactTable caption={COPY.recovery.reposTitle} rows={data.repos} rowKey={(r) => r.repository} columns={cols} />
        ) : (
          <p className={s.emptyNote}>{COPY.recovery.noRepos}</p>
        )}
      </section>

      {receipt ? <div className={s.feedback}><CmdReceipt action={receipt} /></div> : null}

      <div className={s.splitGrid}>
        <section className={s.splitCell} aria-labelledby="recovery-backup-form">
          <div className={s.bandHead}><h2 id="recovery-backup-form" className={s.bandTitle}>{COPY.recovery.backupTitle}</h2></div>
          <form
            className={s.formBody}
            onSubmit={(e) => {
              e.preventDefault();
              backupMut.mutate(
                { backup_type: backupType, window: backupWindow },
                { onSuccess: (res) => setReceipt(res.action) },
              );
            }}
          >
            <div className={s.formGrid}>
              <label className={s.fieldLabel}>
                <span>{COPY.recovery.backupTypeLabel}</span>
                <SelectField label={COPY.recovery.backupTypeLabel} value={backupType} options={BACKUP_TYPE_OPTIONS} onChange={(v) => setBackupType(v as "full" | "diff" | "incr")} />
              </label>
              <label className={s.fieldLabel}>
                <span>{COPY.recovery.windowLabel}</span>
                <SelectField label={COPY.recovery.windowLabel} value={backupWindow} options={WINDOW_OPTIONS} onChange={(v) => setBackupWindow(v as "window" | "now")} />
              </label>
            </div>
            {backupMut.error ? <InlineError error={backupMut.error} /> : null}
            <div className={s.inlineRow}>
              <button type="submit" className="btn btn--sm btn--primary" disabled={!canBackup || backupMut.isPending}>
                {COPY.recovery.backupBtn}
              </button>
              {!canBackup ? <DisabledReason reason={COPY.o0.reasons.actionDenied} /> : null}
            </div>
          </form>
        </section>

        <section className={s.splitCell} aria-labelledby="recovery-drill-form">
          <div className={s.bandHead}><h2 id="recovery-drill-form" className={s.bandTitle}>{COPY.recovery.drillTitle}</h2></div>
          <form
            className={s.formBody}
            onSubmit={(e) => {
              e.preventDefault();
              setDrillValidation(null);
              const built = buildDrillRequest({
                repo: drillRepo,
                drillType,
                target: drillTarget,
                window: drillWindow,
              });
              if (!built.ok) {
                setDrillValidation(built.error);
                return;
              }
              drillMut.mutate(built.payload, { onSuccess: (res) => setReceipt(res.action) });
            }}
          >
            <div className={s.formGrid}>
              <label className={s.fieldLabel}>
                <span>{COPY.recovery.repoLabel}</span>
                <SelectField label={COPY.recovery.repoLabel} value={drillRepo} options={REPO_OPTIONS} onChange={(v) => setDrillRepo(v as "1" | "2" | "auto")} />
              </label>
              <label className={s.fieldLabel}>
                <span>{COPY.recovery.drillTypeLabel}</span>
                <SelectField
                  label={COPY.recovery.drillTypeLabel}
                  value={drillType}
                  options={DRILL_TYPE_OPTIONS}
                  onChange={(v) => {
                    setDrillType(v as "name" | "time");
                    setDrillValidation(null);
                  }}
                />
              </label>
            </div>
            <div className={s.formGrid}>
              <label className={s.fieldLabel}>
                <span>{COPY.recovery.targetLabel}</span>
                <input
                  type="text"
                  className="field-input--form"
                  placeholder={drillType === "time" ? COPY.recovery.targetPlaceholderTime : COPY.recovery.targetPlaceholderName}
                  value={drillTarget}
                  onChange={(e) => {
                    setDrillTarget(e.target.value);
                    setDrillValidation(null);
                  }}
                />
              </label>
              <label className={s.fieldLabel}>
                <span>{COPY.recovery.windowLabel}</span>
                <SelectField label={COPY.recovery.windowLabel} value={drillWindow} options={WINDOW_OPTIONS} onChange={(v) => setDrillWindow(v as "window" | "now")} />
              </label>
            </div>
            {drillValidation ? <p className={s.validationText} role="alert">{drillValidation}</p> : null}
            {drillMut.error ? <InlineError error={drillMut.error} /> : null}
            <div className={s.inlineRow}>
              <button type="submit" className="btn btn--sm btn--primary" disabled={!canDrill || drillMut.isPending}>
                {COPY.recovery.drillBtn}
              </button>
              {!canDrill ? <DisabledReason reason={COPY.o0.reasons.actionDenied} /> : null}
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

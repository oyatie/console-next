// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";

import { isMessageId, t } from "@console/i18n";
import { fmtZonedDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Denied } from "../../../lib/react/denied";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Checks } from "../../../ui/choice/checks";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { Table } from "../../../ui/table";
import { ApiError, assertBoundPasskey, NOTE_MAX, OTHER, previewRollback, requestRollback, ROLLBACK_REASONS, rollbackReasonsQuery, type ImportRun, type RollbackPreview } from "../api";
import { fieldLabel, importError, reasonLabel, shown } from "../present";
import s from "./import.module.css";

const label = (group: "effect" | "blocker", code: string) => {
  const id = `import.rollback.${group}.${code}`;
  return isMessageId(id) ? t(id) : code;
};
const value = (v: unknown) => shown(v == null ? null : typeof v === "string" ? v : JSON.stringify(v));

/** The server's inverse plan is acknowledged before its digest is submitted. */
export function RollbackPanel({ run, onChanged }: { run: ImportRun; onChanged: () => void }) {
  const canPreview = run.allowed.includes("preview_rollback");
  const preview = useQuery({
    queryKey: ["/api/v1/employee-import-runs/{run_id}/rollback/preview", { path: { run_id: run.id } }],
    queryFn: () => previewRollback(run.id), enabled: canPreview, retry: false,
    staleTime: 0, refetchOnMount: "always",
  });
  const pending = run.status === "ROLLBACK_REQUESTED" || run.status === "ROLLBACK_RUNNING" || Boolean(run.rollback.pending_request);
  const closed = run.rollback.refusal_code === "import_rollback_window_closed" || (preview.error instanceof ApiError && preview.error.code === "import_rollback_window_closed");
  return (
    <section className="card panel form" aria-labelledby="import-rollback">
      <h2 id="import-rollback" className="panel__title">{t("import.rollback.title")}</h2>
      {run.status === "ROLLED_BACK" && run.rolled_back_at && run.rolled_back_by && <p>{t("import.rollback.completedAt", { name: run.rolled_back_by.name ?? run.rolled_back_by.id, at: fmtZonedDateTime(run.rolled_back_at) })}</p>}
      {run.rollback.pending_request && <p>{t("import.rollback.requestedAt", { at: fmtZonedDateTime(run.rollback.pending_request.created_at) })}</p>}
      {run.status === "ROLLED_BACK" ? <p role="status">{t("import.rollback.done")}</p> : pending ? <p role="status">{t(run.status === "ROLLBACK_RUNNING" ? "import.rollback.running" : "import.rollback.wait")}</p> : <>
        <p className="muted">{t("import.rollback.why")}</p>
        {run.rollback.window_until && <p>{t("import.rollback.until", { until: fmtZonedDateTime(run.rollback.window_until), days: run.rollback.window_days })}</p>}
        {closed ? <>
          <p>{t("import.rollback.closed")}</p>
          <Link to="/people" search={{}}>{t("import.rollback.openPeople")}</Link>
        </> : run.rollback.refusal_code ? <CommandError error={new ApiError(409, run.rollback.refusal_code, run.rollback.refusal_code)} own={importError} /> : canPreview ? <QueryState q={preview} own={importError}>
          {(plan) => <Execute key={plan.preview_digest} run={run} plan={plan} onChanged={onChanged} />}
        </QueryState> : <CommandError error={preview.error} own={importError} />}
      </>}
      {run.rollback.job?.error && <CommandError error={new ApiError(run.rollback.job.error.status, run.rollback.job.error.code, run.rollback.job.error.message)} own={importError} />}
      <p className="muted">{t("import.rollback.kept")}</p>
    </section>
  );
}

function Execute({ run, plan, onChanged }: { run: ImportRun; plan: RollbackPreview; onChanged: () => void }) {
  const reasons = useQuery({ ...rollbackReasonsQuery, enabled: plan.mode !== "SETUP" });
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const send = useCommand({
    run: async (_: void, key: string) => {
      const step_up = plan.basis === "STEP_UP" ? await assertBoundPasskey("EXCEPTION_DECIDE", run.id, plan.preview_digest) : undefined;
      return requestRollback(run.id, {
        preview_digest: plan.preview_digest,
        acknowledged: acknowledged.includes("acknowledged"),
        ...(plan.mode !== "SETUP" ? { reason_code: reason.code!, note: reason.memo.trim() || null } : {}),
        step_up,
      }, key);
    },
    invalidates: ["/api/v1/employee-import-runs"],
    announce: (out) => t(out.status === "ROLLED_BACK" ? "import.rollback.done" : out.status === "ROLLBACK_RUNNING" ? "import.rollback.running" : "import.rollback.wait"),
    onSuccess: onChanged,
  });
  if (send.data) return <p role="status">{t(send.data.status === "ROLLED_BACK" ? "import.rollback.done" : send.data.status === "ROLLBACK_RUNNING" ? "import.rollback.running" : "import.rollback.wait")}</p>;
  if (send.error instanceof ApiError && send.error.status === 403) return <Denied error={send.error} />;
  const blocked = plan.blockers.length > 0;
  const reasonMissing = plan.mode !== "SETUP" && Boolean(reasonProblem(reason, OTHER));
  const disabled = blocked || !plan.allowed.includes("rollback") || !acknowledged.includes("acknowledged") || reasonMissing || send.isPending;
  return <>
    <h3>{t("import.rollback.preview")}</h3>
    <p>{t("import.rollback.counts", { inserted: plan.rows.filter((r) => r.inserted).length, updated: plan.rows.filter((r) => !r.inserted).length })}</p>
    {plan.rows.map((row) => <section key={row.employee_id} aria-label={row.employee_number ?? row.employee_id}>
      <h4><Link to="/people/$id" params={{ id: row.employee_id }} search={{}}>{row.employee_number ?? t("import.rows.unnumbered")}</Link></h4>
      {row.inserted && <p>{t("import.rollback.void")}</p>}
      <ul className={s.lines}>
        {row.fields.map((field) => <li key={field.field}>{t("import.rows.change", { field: fieldLabel(field.field), before: value(field.current), after: field.field === "home_branch_id" ? t("import.rollback.branchUnset") : value(field.before) })}</li>)}
        {row.effects.filter((effect) => effect !== "ledger" && effect !== "head_settled" && effect !== "home_branch_set").map((effect) => <li key={effect}>{t("import.rollback.removeEffect", { effect: label("effect", effect) })}</li>)}
      </ul>
    </section>)}
    {blocked && <>
      <p role="alert">{t("import.rollback.blocked")}</p>
      <Table label={t("import.rollback.blockers")} rows={plan.blockers} rowId={(b) => [b.employee_id, b.kind, b.field, b.record, b.since].join(":")} columns={[
        { header: t("import.rollback.person"), cell: (b) => <Link to="/people/$id" params={{ id: b.employee_id }} search={{}}>{b.employee_number ?? b.employee_id}</Link> },
        { header: t("import.rollback.blocker"), cell: (b) => <>{label("blocker", b.kind)}{b.field && <> · {fieldLabel(b.field)}</>}{b.record && <> · {b.record}</>}</> },
        { header: t("import.rollback.since"), cell: (b) => b.since ? fmtZonedDateTime(b.since) : t("import.rows.blank") },
      ]} />
    </>}
    {!blocked && <>
      {plan.mode !== "SETUP" && <>
        <ReasonField label={t("import.rollback.reason")} codes={(reasons.data?.items ?? []).filter((r) => r.active).map((r) => ({ code: r.code, label: reasonLabel(ROLLBACK_REASONS, r) }))} other={OTHER} value={reason} onChange={setReason} memoMax={NOTE_MAX} />
        <CommandError error={reasons.error} />
      </>}
      <Checks label={t("import.rollback.acknowledge")} items={[{ id: "acknowledged", label: t("import.rollback.acknowledged") }]} value={acknowledged} onChange={setAcknowledged} isDisabled={send.isPending} />
      {plan.basis === "STEP_UP" && <p>{t("import.rollback.stepUp")}</p>}
    </>}
    <CommandError error={send.error} own={importError} />
    <div className={s.bar}><Button variant="primary" disabled={disabled} onClick={() => send.mutate(undefined)}>{t(plan.basis === "SECOND_PERSON" ? "import.rollback.request" : "import.rollback.execute")}</Button></div>
  </>;
}

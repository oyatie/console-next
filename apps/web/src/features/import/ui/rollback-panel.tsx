import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTimeShort } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { Button } from "../../../ui/button/button";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { ReasonField } from "../../../ui/reason/reason-field";
import { reasonProblem, type Reason } from "../../../ui/reason/reason";
import { decideRollback, MEMO_MAX, OTHER, requestRollback, ROLLBACK_REASONS, rollbackReasonsQuery } from "../api";
import type { ImportRun } from "../domain/pending";
import { reasonLabel } from "../present";
import s from "./import.module.css";

/**
 * NOT MOUNTED: no backend serves the rollback yet (domain/pending, backend-followups #21 (a)).
 * Rolling an applied run back (BW-10 item 9): one person asks within the window, with a reason; another person
 * approves or refuses. The server decides who may do what (`allowed`); this panel offers exactly that.
 */
export function RollbackPanel({ run, onChanged }: { run: ImportRun; onChanged: () => void }) {
  const rb = run.rollback;
  const canAsk = run.allowed.includes("request_rollback");
  const canDecide = run.allowed.includes("decide_rollback");
  // Read once per mount: whether the window has passed is only worded here; the server's `allowed` decides.
  const [now] = useState(Date.now);
  return (
    <section className="card panel form" aria-labelledby="import-rollback">
      <h2 id="import-rollback" className="panel__title">{t("import.rollback.title")}</h2>
      <p className="muted">{t("import.rollback.why")}</p>
      {run.status === "APPLIED" && run.rollback_until && (
        <p>{canAsk || Date.parse(run.rollback_until) > now ? t("import.rollback.until", { until: fmtDateTimeShort(run.rollback_until) }) : t("import.rollback.closed")}</p>
      )}
      {rb && <p>{t("import.rollback.requested", { name: rb.requested_by.name, at: fmtDateTimeShort(rb.requested_at) })}</p>}
      {rb?.decided_by && rb.decided_at && (
        <p>{t(rb.decision === "APPROVE" ? "import.rollback.approved" : "import.rollback.refused", { name: rb.decided_by.name, at: fmtDateTimeShort(rb.decided_at) })}</p>
      )}
      {run.rollback_kept.length > 0 && (
        <p>{t("import.rollback.kept", { count: run.rollback_kept.length, names: run.rollback_kept.map((p) => p.name).join(", ") })}</p>
      )}
      {canAsk && <Ask run={run} onChanged={onChanged} />}
      {run.status === "ROLLBACK_REQUESTED" && (canDecide ? <Decide run={run} onChanged={onChanged} /> : <p className="muted">{t("import.rollback.wait")}</p>)}
    </section>
  );
}

function Ask({ run, onChanged }: { run: ImportRun; onChanged: () => void }) {
  const reasons = useQuery(rollbackReasonsQuery);
  const [reason, setReason] = useState<Reason>({ code: null, memo: "" });
  const [tried, setTried] = useState(false);
  const ask = useCommand({
    run: (_: void, key: string) => requestRollback(run.id, { code: reason.code!, memo: reason.memo }, key),
    announce: () => t("import.rollback.announce.requested"),
    onSuccess: onChanged,
  });
  const codes = (reasons.data?.items ?? []).filter((r) => r.active).map((r) => ({ code: r.code, label: reasonLabel(ROLLBACK_REASONS, r) }));
  const problem = reasonProblem(reason, OTHER);
  return (
    <>
      <ReasonField label={t("import.rollback.reason")} codes={codes} other={OTHER} value={reason} onChange={setReason} memoMax={MEMO_MAX} showErrors={tried} />
      <CommandError error={ask.error ?? reasons.error} />
      <div className={s.bar}>
        {problem ? (
          <DisabledReason control={(p) => <Button {...p} variant="primary" onClick={() => setTried(true)}>{t("import.rollback.request")}</Button>} reason={t("import.rollback.needReason")} />
        ) : (
          <Button variant="primary" disabled={ask.isPending} onClick={() => ask.mutate(undefined)}>{t("import.rollback.request")}</Button>
        )}
      </div>
    </>
  );
}

function Decide({ run, onChanged }: { run: ImportRun; onChanged: () => void }) {
  const decide = useCommand({
    run: (d: "APPROVE" | "REFUSE", key: string) => decideRollback(run.id, d, key),
    announce: () => t("import.rollback.announce.decided"),
    onSuccess: onChanged,
  });
  return (
    <>
      <CommandError error={decide.error} />
      <div className={s.bar}>
        <Button disabled={decide.isPending} onClick={() => decide.mutate("REFUSE")}>{t("import.rollback.refuse")}</Button>
        <Button variant="primary" disabled={decide.isPending} onClick={() => decide.mutate("APPROVE")}>{t("import.rollback.approve")}</Button>
      </div>
    </>
  );
}

import { useCallback } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtZonedDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { SectionHead } from "../../../ui/card/section-head";
import { runQuery } from "../api";
import { STATUS_TONE, statusLabel } from "../present";
import type { ImportReport } from "../domain/contract";
import { ReconcilePanel } from "./reconcile-panel";
import { RegisterGaps } from "./register-gaps";
import { JobStep } from "./job-step";

/** What apply wrote. Differences import never writes stay with their own flows (appointment, exit, correction). */
export function DoneStep({ report, runId }: { report?: ImportReport; runId: string }) {
  const run = useQuery({ ...runQuery(runId), refetchOnMount: "always" });
  const navigate = useNavigate();
  const completed = useCallback(() => void run.refetch(), [run.refetch]);
  const restart = useCallback(() => void navigate({ to: "/people/import", search: {} }), [navigate]);
  if (run.data?.apply_job_state && run.data.apply_job_state !== "done") {
    return <JobStep runId={runId} onDone={completed} onFailed={restart} />;
  }
  return (
    <>
    <section className="card panel" aria-labelledby="import-done">
      <h2 id="import-done" className="panel__title" tabIndex={-1}>{t(run.data?.status === "APPLIED" ? "import.done.title" : "import.run.title")}</h2>
      <QueryState q={run}>
        {(r) => <>
          <SectionHead tools={<Chip tone={STATUS_TONE[r.status]}>{statusLabel(r.status)}</Chip>}>{r.source_filename}</SectionHead>
          <p className="muted">
            {r.applied_at && r.applied_by ? <time dateTime={r.applied_at}>
              {t("import.run.applied", { name: r.applied_by.name ?? r.applied_by.id, at: fmtZonedDateTime(r.applied_at) })}
            </time> : t("import.run.notApplied")}
          </p>
          {r.apply_summary && <p>{t("import.summary", { inserted: r.apply_summary.inserted, updated: r.apply_summary.updated, skipped: r.apply_summary.skipped })}</p>}
        </>}
      </QueryState>
      <div className="form__actions">
        <Link to="/people/import" search={{}} className="btn" reloadDocument>{t("import.again")}</Link>
        <Link to="/people" search={{}} className="btn btn--primary">{t("import.viewEmployees")}</Link>
      </div>
    </section>
    {report?.register_gaps && <RegisterGaps gaps={report.register_gaps} />}
    {run.data?.status === "APPLIED" && <ReconcilePanel runId={runId} />}
    </>
  );
}

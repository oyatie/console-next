import { useEffect } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { isMessageId, t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { Banner } from "../../../ui/banner/banner";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { buttonClass } from "../../../ui/button/button-class";
import { applyJobQuery } from "../api";
import type { ApplyJob, ImportReport } from "../domain/contract";
import { keepJob, share } from "../domain/job";

/** Why a job failed, in words (nothing was written by a failed job's refusal; the dry run is run again). */
const failedWhy = (code?: string) => (code && isMessageId(`importJob.error.${code}`) ? t(`importJob.error.${code}` as "importJob.error.apply_interrupted") : t("importJob.error.other"));

/**
 * The apply as a job (r3:hire-02, records-15, worst-case-15, EMP-E12-jobs): the server writes the approved dry run
 * while this shows how far it is, read again on each `import_run` frame of the event stream (never polled, #27).
 * The page may be left: coming back to the import re-attaches here. Done hands the report to the done step, so the
 * migration check always follows; a failed job says why and goes back to the dry run.
 */
export function JobStep({ runId, onDone, onFailed }: { runId: string; onDone: (r: ImportReport) => void; onFailed: () => void }) {
  const q = useQuery({ ...applyJobQuery(runId), refetchOnMount: "always" });
  const job = q.data as ApplyJob | undefined;
  useEffect(() => {
    if (job?.state === "done" && job.report) {
      keepJob(null);
      onDone(job.report);
    }
    if (job?.state === "failed") keepJob(null);
  }, [job, onDone]);
  // No job for the kept run (another tenant's, or never started): nothing to follow.
  const missing = q.isError;
  useEffect(() => void (missing && (keepJob(null), onFailed())), [missing, onFailed]);
  const pct = Math.round((job ? share(job) : 0) * 100);
  return (
    <Card titleId="import-job" title={t("importJob.title")}>
      {job?.state === "failed" ? (
        <Banner tone="danger" live="assertive" title={t("importJob.failed")} actions={<Button variant="primary" onClick={onFailed}>{t("importJob.back")}</Button>}>
          {failedWhy(job.error?.code)}
        </Banner>
      ) : (
        <>
          <p>{t(`importJob.state.${job?.state === "applying" || job?.state === "settling" ? job.state : "queued"}`)}</p>
          <p className="muted num" role="progressbar" aria-label={t("importJob.title")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            {t("importJob.rows", { done: fmtNumber(job?.done ?? 0), total: fmtNumber(job?.total ?? 0) })}
          </p>
          <p className="muted">{t("importJob.leave")}</p>
          <div className="form__actions">
            <Link to="/people" search={{}} className={buttonClass("ghost")}>{t("importJob.toRoster")}</Link>
          </div>
        </>
      )}
    </Card>
  );
}

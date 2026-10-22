import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { runQuery } from "../api";
import { STATUS_TONE, statusLabel } from "../present";
import { RollbackPanel } from "./rollback-panel";
import { RunSummary } from "./run-summary";

/**
 * NOT MOUNTED (no route): no backend serves the run record yet (domain/pending, backend-followups #21 (a)). Mount at
 * /people/import/runs/$runId and link it from the done step and the upload step's recent runs once it is published.
 * One import run's record: who applied what, per legal entity, and its rollback (asked by one person, decided by another).
 */
export function ImportRunPage({ runId }: { runId: string }) {
  const run = useQuery({ ...runQuery(runId), refetchOnMount: "always" });
  return (
    <div className="page">
      <div className="page__head">
        <Link to="/people/import" className="btn btn--ghost">{t("import.title")}</Link>
        <h1 className="page__title">{t("import.run.title")}</h1>
      </div>
      <section className="card panel" aria-label={t("import.run.title")}>
        <QueryState q={run}>
          {(r) => (
            <>
              <div className="toolbar">
                <h2 className="toolbar__title">{r.source_filename}</h2>
                <Chip tone={STATUS_TONE[r.status]}>{statusLabel(r.status)}</Chip>
              </div>
              <p className="muted">
                {r.applied_at && r.applied_by ? t("import.run.applied", { name: r.applied_by.name, at: fmtDateTime(r.applied_at) }) : t("import.run.notApplied")}
              </p>
              <RunSummary run={r} />
            </>
          )}
        </QueryState>
      </section>
      {run.data && run.data.applied_at && <RollbackPanel run={run.data} onChanged={() => void run.refetch()} />}
    </div>
  );
}

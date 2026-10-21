import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import type { ImportReport } from "../domain/contract";
import { ReconcilePanel } from "./reconcile-panel";
import { RegisterGaps } from "./register-gaps";

/** What apply wrote. Differences import never writes stay with their own flows (appointment, exit, correction). */
export function DoneStep({ report, runId }: { report?: ImportReport; runId: string }) {
  return (
    <>
    <section className="card panel" aria-labelledby="import-done">
      <h2 id="import-done" className="panel__title" tabIndex={-1}>{t("import.done.title")}</h2>
      {report && <p>{t("import.summary", { inserted: report.inserted, updated: report.updated, skipped: report.skipped })}</p>}
      <div className="form__actions">
        <Link to="/people/import" search={{}} className="btn" reloadDocument>{t("import.again")}</Link>
        <Link to="/people" search={{}} className="btn btn--primary">{t("import.viewEmployees")}</Link>
      </div>
    </section>
    {report?.register_gaps && <RegisterGaps gaps={report.register_gaps} />}
    <ReconcilePanel runId={runId} />
    </>
  );
}

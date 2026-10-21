import { t } from "@console/i18n";
import type { ImportRun } from "../domain/pending";

/** An applied run's counts (the run record, not served yet: domain/pending). */
export function RunSummary({ run }: { run: ImportRun }) {
  return <p>{t("import.summary", { inserted: run.inserted, updated: run.updated, skipped: run.skipped })}</p>;
}

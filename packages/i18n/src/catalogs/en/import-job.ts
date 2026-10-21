// English for `importJob.` ids (features/import/ui/job-step.tsx): the apply running as a job (r3:hire-02).
import type { koImportJob } from "../ko/import-job";

export const enImportJob: Record<keyof typeof koImportJob, string> = {
  "importJob.title": "Applying the roster",
  "importJob.state.queued": "Starting · writing exactly the dry run you approved",
  "importJob.state.applying": "Adding people to the roster",
  "importJob.state.settling": "Recording placements and employment details",
  "importJob.rows": "{done} / {total} rows",
  "importJob.leave": "You can leave this screen: the server finishes the apply. Come back to the import to pick it up here.",
  "importJob.toRoster": "To the roster (the apply continues)",
  "importJob.failed": "The apply stopped",
  "importJob.back": "Back to the dry run",
  "importJob.error.rows_changed_since_preview": "People changed after the dry run, so nothing was written. Run the dry run again.",
  "importJob.error.dry_run_digest_mismatch": "The approved dry run is no longer this import's latest, so nothing was written. Run the dry run again.",
  "importJob.error.apply_interrupted": "The apply stopped before writing anything. Go back to the dry run and apply again.",
  "importJob.error.other": "The apply stopped. Run the dry run again: rows already in come back as unchanged.",
  "importJob.started": "The roster apply has started",
};

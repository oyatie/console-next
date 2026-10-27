import { IMPORT_OUTCOME, LEAVE_TYPE, label } from "../../lib/labels";
// Words for the import contract's codes. Every enum on screen goes through here, never the raw code.
import { i18n, isMessageId, t } from "@console/i18n";
import type { Classification, ImportDeferred, ImportOutcome, ImportRow, ReasonCatalogEntry, ReviewItem } from "./domain/contract";

/** A code's words when the catalog has them; otherwise the code (a value the server added after this build). */
const known = (id: string, code: string) => (isMessageId(id) ? t(id) : code);

/** A target, diff or deferred field, worded as the employee field it fills. */
export const fieldLabel = (field: string) => field === "home_branch_id" ? t("importRollback.homeBranch") : known(`import.target.${field}`, field);

export const classLabel = (c: Classification) => t(`import.class.${c}`);

export const outcomeLabel = (o: ImportOutcome) => label(IMPORT_OUTCOME, o);
/** Where a column's meaning came from: the built-in labels, the tenant's memory, or the operator just now. */
export const sourceLabel = (s: string) => known(`importSheet.source.${s}`, s);
export const candidateBasisLabel = (basis: string) => known(`importValues.basis.${basis}`, basis);

export const routeLabel = (r: ImportDeferred["route"]) => known(`import.route.${r}`, r);
export const refusalLabel = (code: string) => known(`import.refusal.${code}`, code);
export const employmentTypeLabel = (code: string) => known(`enum.employmentType.${code}`, code);
export const employeeStatusLabel = (code: string) => known(`enum.employeeStatus.${code}`, code);
export const leaveTypeLabel = (code: string) => known(`import.leaveType.${code}`, label(LEAVE_TYPE, code));
export const matchedLabel = (m: NonNullable<ImportRow["matched_by"]>) => known(`import.matched.${m}`, m);
export const numberSourceLabel = (s: string) => known(`import.numberSource.${s}`, s);

/** A needs-review reason: a queue reason, else a refusal code worded as one. */
export const reviewReasonLabel = (i: ReviewItem) => {
  const id = `importReview.reason.${i.reason}`;
  return isMessageId(id) ? t(id) : refusalLabel(i.reason);
};
/** A remembered or served choice of a value map (employment status, leave type) in words. */
export const choiceLabel = (decision: string, choice: string) =>
  decision === "status_map" ? employeeStatusLabel(choice) : decision === "leave_type_map" ? leaveTypeLabel(choice) : decision === "employment_type_map" ? employmentTypeLabel(choice) : choice;
export const decisionLabel = (d: string) => known(`import.decision.${d}`, d);

/** The words of an import error code this screen knows better than the generic copy (CommandError `own`). */
export const importError = (code: string) => {
  const id = `import.error.${code}`;
  const refusal = `import.refusal.${code}`;
  return isMessageId(id) ? t(id) : isMessageId(refusal) ? t(refusal) : undefined;
};

/** A value before or after a change; a blank one is said, never left as an empty gap. */
export const shown = (v?: string | null) => (v == null || v === "" ? t("import.rows.blank") : v);

/** A reason code's words: a tenant code carries its own label, a system code its catalog entry. */
export const reasonLabel = (domain: string, r: ReasonCatalogEntry) =>
  (i18n.locale === "en" ? r.label_en : r.label_ko) ?? r.label_ko ?? known(`import.reason.${domain}.${r.code}`, r.code);

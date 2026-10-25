// The import contract published by the backend.
import type { components } from "@console/api/schema";

type S = components["schemas"];

export type ImportPreview = S["EmployeeImportPreviewResponse"];
export type ImportColumn = ImportPreview["columns"][number];
export type Classification = ImportColumn["classification"];
export type ImportSheet = S["EmployeeImportSheetReport"];
export type SheetStatus = ImportSheet["status"];
export type ImportDryRun = Omit<S["EmployeeImportDryRunSummary"], "decisions" | "review"> & { decisions: ImportDecisions; review: Omit<S["EmployeeImportDryRunSummary"]["review"], "items"> & { items: ReviewItem[] } };
export type ImportRow = S["EmployeeImportPlannedRow"];
export type ImportOutcome = ImportRow["outcome"];
export type ImportDecisions = S["EmployeeImportDecisions"] & { company_map?: Record<string, string | null> };
export type ImportDeferred = NonNullable<ImportRow["deferred"]>[number];
export type ImportCandidate = NonNullable<ImportRow["candidates"]>[number];
export type ImportReport = S["EmployeeImportReport"];
/** The apply job of a run (W11): queued → applying → settling → done, or failed with its refusal. */
export type ApplyJob = S["EmployeeImportApplyJob"];
export type NewPerson = NonNullable<ImportRow["new_person"]>;
export type EmploymentTypeCode = NonNullable<NewPerson["employment_type"]>;
export type ImportStatus = NonNullable<ImportDecisions["status_map"]>[string];
export type LeaveType = NonNullable<ImportDecisions["leave_type_map"]>[string];
export type Resolution = Omit<NonNullable<S["EmployeeImportReviewItem"]["resolution"]>, "decision"> & { decision: NonNullable<S["EmployeeImportReviewItem"]["resolution"]>["decision"] | "company_map" };
export type ReviewItem = Omit<S["EmployeeImportReviewItem"], "resolution" | "candidates"> & { resolution?: Resolution | null; source_column?: string; candidates?: (NonNullable<S["EmployeeImportReviewItem"]["candidates"]>[number] & { alias?: string | null })[] };
export type CompanyConfirmation = { value: string; source_column: string | null; cell: string | null; registration_number: string | null; candidates: { id: string; name: string; alias?: string | null; basis: string }[]; confirmed_employer: string | null };
export type ImportReconcileRow = S["EmployeeImportReconcileRow"] & { company_confirmation?: CompanyConfirmation };
export type Decision = Resolution["decision"];
export type ReasonCatalogEntry = S["ReasonCatalogEntry"];

/** Every employment type code the server takes, in its order. */
export const EMPLOYMENT_TYPES: readonly EmploymentTypeCode[] = [
  "REGULAR", "CONTRACT", "PART_TIME", "INTERN", "DAILY", "EXECUTIVE", "DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE",
];
/** employment status codes a status text maps to, and leave types (IMPORT-2). */
export const IMPORT_STATUSES: readonly ImportStatus[] = ["ACTIVE", "ON_LEAVE", "PRE_HIRE", "EXITED"];
export const LEAVE_TYPES: readonly LeaveType[] = ["CHILDCARE", "MATERNITY", "ILLNESS", "PERSONAL", "OTHER"];

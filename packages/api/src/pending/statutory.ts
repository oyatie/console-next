export type FilingReason = "AGE_LIMIT" | "MINOR_OPT_OUT" | "SHORT_HOURS" | "DAILY_UNDER_MONTH" | "DAILY_WORK_CONFIRMATION" | "TREATY_EXCLUDED" | "VISA_EXCLUDED" | "EXECUTIVE_NOT_WORKER" | "OTHER_LEGAL_GROUND";
export type FilingFacts = {
 birth_date?: string | null; monthly_hours?: number | null; weekly_hours?: number | null; continuous_months?: number | null;
 worked_monthly_hours?: number | null; daily?: boolean | null; work_days?: number | null; pension_opt_in?: boolean | null; pension_lecturer_covered?: boolean | null; pension_daily_sector?: "GENERAL" | "CONSTRUCTION_NOTICE" | "UNVERIFIED" | null; minor_opt_out?: boolean | null;
 multiple_jobs_covered?: boolean | null; income_exception_covered?: boolean | null; monthly_income_won?: number | null;
 foreign?: boolean | null; treaty?: "COVERED" | "EXCLUDED" | "UNVERIFIED" | null;
 visa?: "MANDATORY" | "OPTED_IN" | "OPTIONAL_NOT_OPTED_IN" | "EXCLUDED" | "UNVERIFIED" | null;
 director_without_worker_status?: boolean | null;
};
export type FilingCitation = {instrument: string; article: string; promulgation: string; source_url: string; enforced_on: string};
type FilingDates = {opens_on: string; target_on: string; due_on: string | null; legal_latest_candidate: string | null; conservative: boolean; without_delay: boolean; holiday_roll_unverified: boolean};
type FilingBasis = {code: string; citation: FilingCitation; applicability_citations: FilingCitation[]; remuneration_required: boolean; daily_required?: boolean;
 exclusions: {type: string; weekly?: number | null; pension_exceptions?: boolean; days_exception?: number | null; hours_exception?: number | null}[]; covered_by: string | null; penalty: {citation: FilingCitation; delay_won: number[]; per_worker: boolean; cap_won: number | null} | null};
// Served by CX-statutory's OpenAPI. INTEG replaces this overlay when regenerating schema.d.ts.
export type FilingTask = {
  lifecycle_case_id?: string | null;
  event_id: string; filing_obligation_id?: string | null; opens_in_days?: number | null; employee_id: string; name: string; employee_number: string | null;
  kind: string; insurer: string; effective_date: string; legal_entity_id: string | null;
  workplace_id: string | null; workplace_name: string | null; due_date: string | null;
  due_in_days: number | null; deadline_status: string; version: number; completed_on: string | null;
  receipt_number: string | null; loss_code: string | null; detail: string | null;
  opens_on: string | null; target_on: string | null; due_on: string | null; dates: FilingDates | null;
  basis: FilingBasis | null; applicability: {status: "APPLIES"} | {status: "NOT_APPLICABLE"; reason: FilingReason} | {status: "UNKNOWN"; missing: string[]};
  applicability_facts: FilingFacts; can_record_sensitive_facts: boolean; birth_date_known: boolean; state: string; record_action: string | null; not_applicable_reason: FilingReason | null; not_applicable_options: FilingReason[];
  total_remuneration_won: number | null; is_request: boolean; acquired_on: string | null;
  loss_options: { code: string; label: string; requires_detail: boolean; held: boolean }[];
};
export type FilingPage = { items: FilingTask[]; total: number; pending: number; next: string | null };
export type RegisterPage = {
  as_of: string; workplace_id: string; workplace_name: string; headers: string[];
  items: { employee_id: string; cells: string[]; missing: string[] }[]; total: number; next: string | null;
};
export type RecordFiling = { expected_version: number; action: "COMPLETE" | "UNDO" | "NOT_APPLICABLE" | "ASSESS"; completed_on?: string; receipt_number?: string; loss_code?: string; detail?: string; not_applicable_reason?: FilingReason; applicability_facts?: FilingFacts; total_remuneration_won?: number };
type Read<T, Q> = { parameters: { query?: Q }; responses: { 200: { content: { "application/json": T } } } };
type RegisterQuery = { workplace_id: string; as_of: string; after?: string; limit?: number };
export type StatutoryPaths = {
  "/api/v1/statutory/workplaces": { get: Read<{id: string; name: string; entity_name: string | null}[], {as_of?: string}> };
  "/api/v1/statutory/insurance-filings": { get: Read<FilingPage, {workplace_id?: string; legal_entity_id?: string; search?: string; state?: string; after?: string; limit?: number; event_id?: string; filing_id?: string; kind?: string; insurer?: string}>; post: {parameters: {header: {"Idempotency-Key": string}}; requestBody: {content: {"application/json": {source_event_id: string; filing_kind: string; anchor_on: string}}}; responses: {200: {content: {"application/json": FilingPage}}}} };
  "/api/v1/statutory/worker-register": { get: Read<RegisterPage, RegisterQuery> };
  "/api/v1/statutory/worker-register/export": { get: { parameters: {query: RegisterQuery & {format: "xlsx" | "pdf"; export_purpose: string} }; responses: {200: {content: {"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": string; "application/json": RegisterPage}}} } };
  "/api/v1/statutory/insurance-filings/{event_id}/{kind}/{insurer}": {
    post: { parameters: {path: {event_id: string; kind: string; insurer: string}; header: {"Idempotency-Key": string} }; requestBody: { content: {"application/json": RecordFiling} }; responses: {200: {content: {"application/json": FilingTask}}} };
  };
};

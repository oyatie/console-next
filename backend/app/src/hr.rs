use std::collections::{BTreeMap, BTreeSet};

use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use console_governance_domain::{GateChainConfig, GateEvidence, evaluate_gate_chain};
pub(crate) use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::authz::{
    authorize_hr_attendance_branch_query, authorize_hr_org_wide, authorize_hr_scoped,
};
pub(crate) use console_hr_adapter_postgres::clock::today_kst;
pub(crate) use console_hr_adapter_postgres::digest::sha256_hex;
use console_hr_adapter_postgres::directory::access_log::{
    DirectoryAccess, access_event, actor_employee_id, import_rows_event,
};
use console_hr_adapter_postgres::directory::read_list::EmployeeListQuery;
use console_hr_adapter_postgres::directory::read_org_chart::HrOrgChartResponse;
pub(crate) use console_hr_adapter_postgres::directory::types::{
    CreateEmployeeRequest, EmployeeDetailResponse,
};
use console_hr_adapter_postgres::directory::types::{
    EmployeeHomeBranchResponse, EmployeePage, SetEmployeeHomeBranchRequest,
};
use console_hr_adapter_postgres::exits::queries::{ExitCaseFilters, load_exit_cases};
use console_hr_adapter_postgres::exits::types::{
    CloseEmployeeExitCaseRequest, ConfirmEmployeeExitCaseRequest, DraftEmployeeExitApprovalRequest,
    EmployeeExitCasePage, EmployeeExitCaseResponse, ExitCaseListQuery,
    ReportEmployeeExitCaseRequest,
};
use console_hr_adapter_postgres::idempotency::normalize_idempotency_key;
use console_hr_adapter_postgres::import::canonical::json_value_text;
use console_hr_adapter_postgres::import::header::{MAX_IMPORT_HEADER_SCAN_ROWS, reject_rrn_label};
#[cfg(all(test, not(feature = "test-postgres")))]
use console_hr_adapter_postgres::import::identity::employee_identity_resolution_from_metadata;
use console_hr_adapter_postgres::import::mask::safe_preview_value;
use console_hr_adapter_postgres::import::parsed::ImportRowStatus;
use console_hr_adapter_postgres::import::persist::persistable_import_row;
use console_hr_adapter_postgres::import::sheet::cell_json as sheet_cell_json;
use console_hr_adapter_postgres::import::store::import_run_for_update;
use console_hr_adapter_postgres::import::types::{
    DataImportRunRecord, ImportApplyRequest, XlsxUpload,
};
use console_hr_adapter_postgres::lifecycle::events_page::LifecycleEventsQuery;
use console_hr_adapter_postgres::lifecycle::requests::{
    BulkEmployeeLifecycleEventRequest, CancelLifecycleEventRequest,
    CreateEmployeeLifecycleEventRequest, EmployeeLifecycleEventPage,
};
use console_hr_adapter_postgres::lifecycle::types::EmployeeLifecycleEventResponse;
use console_hr_adapter_postgres::metrics::record_hr_read;
use console_hr_adapter_postgres::paging::{DEFAULT_LIMIT, MAX_LIMIT};
use console_hr_adapter_postgres::scope_sql::push_branch_scope_column;
#[cfg(test)]
use console_hr_domain::import::classification::{
    employee_import_column_classification, is_dropped_employee_import_header,
};
use console_hr_domain::import::classification::{import_header_match_key, normalize_header_label};
use console_hr_domain::import::grid::GridSheet;
use console_hr_domain::import::pii as import_pii;
use console_hr_domain::import::rrn::is_rrn_value;
use console_hr_domain::import::rrn_value::RrnVault;
use console_hr_rest::HrApiError;
use console_kernel_core::{
    AuditAction, AuditEvent, BranchId, BranchScope, KernelError, OrgId, TraceContext, UserId,
};
use console_leave_adapter_postgres::PgLeaveStore;
// `ObjectKey::Employment`'s owner. Every `employees` statement this module used
// to hold lives there now; console-app is no longer a second writer of it.
#[cfg(test)]
use console_ontology_canonical_adapter_postgres::employment;
use console_platform_auth::{JwtVerifier, PasskeyService};
use console_platform_authz::{Action, Feature, Principal, authorize};
use console_platform_db::idempotency::{IDEMPOTENCY_KEY_HEADER, validate_idempotency_key};
use console_platform_db::{with_audit, with_audits, with_org_conn};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sqlx::{PgPool, Postgres, QueryBuilder, Row};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

#[cfg(test)]
mod error_wire_pins;
mod rrn_vault;
mod workbook_read;
// BE-MIG: the employee import handlers (backlog §4.2 foundation commit).
mod employee_import;
use employee_import::{
    apply_employee_import, dry_run_employee_import, employee_import_apply_job, import_employees,
    list_import_unplaced, preview_employee_import,
};

pub const EMPLOYEES_PATH: &str = "/api/v1/employees";
pub const EMPLOYEE_DETAIL_PATH_TEMPLATE: &str = "/api/v1/employees/{id}";
pub const EMPLOYEES_IMPORT_PATH: &str = "/api/v1/employees/import";
pub const EMPLOYEES_IMPORT_PREVIEW_PATH: &str = "/api/v1/employees/import/preview";
pub const EMPLOYEES_IMPORT_DRY_RUN_PATH_TEMPLATE: &str =
    "/api/v1/employees/import/{run_id}/dry-run";
pub const EMPLOYEES_IMPORT_APPLY_PATH_TEMPLATE: &str = "/api/v1/employees/import/{run_id}/apply";
/// BE-MIG (W03 / E8): the 미배치 queue.
pub const EMPLOYEES_IMPORT_UNPLACED_PATH: &str = "/api/v1/employees/import/unplaced";
pub const EMPLOYEES_EXPORT_CSV_PATH: &str = "/api/v1/employees/export.csv";
pub const EMPLOYEE_FACETS_PATH: &str = "/api/v1/employees/facets";
pub const EMPLOYEE_LIFECYCLE_EVENTS_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/lifecycle-events";
pub const EMPLOYEES_LIFECYCLE_BULK_PATH: &str = "/api/v1/employees/lifecycle-events/bulk";
pub const EMPLOYEE_LIFECYCLE_EVENT_CANCEL_PATH_TEMPLATE: &str =
    "/api/v1/employees/{id}/lifecycle-events/{event_id}/cancel";
pub const EMPLOYEE_HOME_BRANCH_PATH_TEMPLATE: &str = "/api/v1/employees/{id}/home-branch";
pub const HR_ORG_CHART_PATH: &str = "/api/v1/hr/org-chart";
pub const HR_LEAVE_BALANCES_PATH: &str = "/api/v1/hr/leave-balances";
pub const HR_ATTENDANCE_SUMMARY_PATH: &str = "/api/v1/hr/attendance-summary";
pub const HR_READINESS_SUMMARY_PATH: &str = "/api/v1/hr/readiness-summary";
pub const HR_ATTENDANCE_IMPORT_PREVIEW_PATH: &str = "/api/v1/hr/attendance-import/preview";
pub const HR_ATTENDANCE_IMPORT_DRY_RUN_PATH_TEMPLATE: &str =
    "/api/v1/hr/attendance-import/{run_id}/dry-run";
pub const HR_ATTENDANCE_IMPORT_APPLY_PATH_TEMPLATE: &str =
    "/api/v1/hr/attendance-import/{run_id}/apply";
pub const HR_ATTENDANCE_IMPORT_SUMMARY_PATH: &str = "/api/v1/hr/attendance-import/summary";
pub const HR_MY_ATTENDANCE_RECORDS_PATH: &str = "/api/v1/hr/attendance-records/me";
pub const HR_ATTENDANCE_RECORDS_PATH: &str = "/api/v1/hr/attendance-records";
pub const HR_ABSENCE_EXIT_DASHBOARD_PATH: &str = "/api/v1/hr/absence-exit-dashboard";
pub const HR_EXIT_CASES_PATH: &str = "/api/v1/hr/exit-cases";
pub const HR_EXIT_CASE_PATH_TEMPLATE: &str = "/api/v1/hr/exit-cases/{id}";
pub const HR_EXIT_CASE_CONFIRM_PATH_TEMPLATE: &str = "/api/v1/hr/exit-cases/{id}/confirm";
pub const HR_EXIT_CASE_REJECT_PATH_TEMPLATE: &str = "/api/v1/hr/exit-cases/{id}/reject";
pub const HR_EXIT_CASE_CANCEL_PATH_TEMPLATE: &str = "/api/v1/hr/exit-cases/{id}/cancel";
pub const HR_EXIT_CASE_APPROVAL_DRAFT_PATH_TEMPLATE: &str =
    "/api/v1/hr/exit-cases/{id}/approval-draft";
pub const HR_ROUTE_PATHS: &[&str] = &[
    EMPLOYEES_PATH,
    EMPLOYEE_DETAIL_PATH_TEMPLATE,
    EMPLOYEES_IMPORT_PATH,
    EMPLOYEES_IMPORT_PREVIEW_PATH,
    EMPLOYEES_IMPORT_DRY_RUN_PATH_TEMPLATE,
    EMPLOYEES_IMPORT_APPLY_PATH_TEMPLATE,
    EMPLOYEES_IMPORT_UNPLACED_PATH,
    EMPLOYEES_EXPORT_CSV_PATH,
    EMPLOYEE_FACETS_PATH,
    EMPLOYEE_LIFECYCLE_EVENTS_PATH_TEMPLATE,
    EMPLOYEES_LIFECYCLE_BULK_PATH,
    EMPLOYEE_LIFECYCLE_EVENT_CANCEL_PATH_TEMPLATE,
    EMPLOYEE_HOME_BRANCH_PATH_TEMPLATE,
    HR_ORG_CHART_PATH,
    HR_LEAVE_BALANCES_PATH,
    HR_ATTENDANCE_SUMMARY_PATH,
    HR_READINESS_SUMMARY_PATH,
    HR_ATTENDANCE_IMPORT_PREVIEW_PATH,
    HR_ATTENDANCE_IMPORT_DRY_RUN_PATH_TEMPLATE,
    HR_ATTENDANCE_IMPORT_APPLY_PATH_TEMPLATE,
    HR_ATTENDANCE_IMPORT_SUMMARY_PATH,
    HR_MY_ATTENDANCE_RECORDS_PATH,
    HR_ATTENDANCE_RECORDS_PATH,
    HR_ABSENCE_EXIT_DASHBOARD_PATH,
    HR_EXIT_CASES_PATH,
    HR_EXIT_CASE_PATH_TEMPLATE,
    HR_EXIT_CASE_CONFIRM_PATH_TEMPLATE,
    HR_EXIT_CASE_REJECT_PATH_TEMPLATE,
    HR_EXIT_CASE_CANCEL_PATH_TEMPLATE,
    HR_EXIT_CASE_APPROVAL_DRAFT_PATH_TEMPLATE,
];
mod attendance_rules;
mod lane_routes;
use attendance_rules::{
    next_employee_attendance_state, normalize_attendance_kind, normalize_attendance_note,
};

/// The upload body limit: the registry default of `import.upload.max_mib`
/// (a platform switch) plus room for the multipart envelope; the per-tenant
/// value is checked while the file streams.
fn max_import_body() -> usize {
    console_hr_adapter_postgres::import::caps::default_caps()
        .map_or(0, |caps| {
            usize::try_from(caps.max_upload_bytes).unwrap_or(usize::MAX)
        })
        .saturating_add(1 << 20)
}
#[derive(Clone)]
pub struct HrState {
    pool: PgPool,
    hr: HrService,
    leave_command_store: Option<PgLeaveStore>,
    jwt_verifier: Option<JwtVerifier>,
    passkey_step_up: Option<PasskeyService>,
    /// IMPORT-2: the 주민등록번호 vault (keys from the environment), if set.
    rrn_vault: Option<std::sync::Arc<dyn RrnVault>>,
}

// --- lane: PEOPLE-B --- the hr-rest directory handlers take the HrService.
impl axum::extract::FromRef<HrState> for HrService {
    fn from_ref(state: &HrState) -> Self {
        state.hr.clone()
    }
}

impl HrState {
    #[must_use]
    pub fn new(pool: PgPool, jwt_verifier: Option<JwtVerifier>) -> Self {
        Self {
            hr: HrService::new(pool.clone()),
            pool,
            leave_command_store: None,
            jwt_verifier,
            passkey_step_up: None,
            rrn_vault: rrn_vault::from_env_logged(),
        }
    }

    #[must_use]
    pub fn with_leave_command_store(mut self, store: PgLeaveStore) -> Self {
        self.leave_command_store = Some(store);
        self
    }
}

pub fn router(state: HrState) -> Router {
    let verifier = state.jwt_verifier.clone();
    let pool = state.pool.clone();
    let lanes = state.clone();
    let router = Router::new()
        .route(EMPLOYEES_PATH, get(list_employees).post(create_employee))
        .route(EMPLOYEE_DETAIL_PATH_TEMPLATE, get(get_employee_detail))
        .route(EMPLOYEE_FACETS_PATH, get(console_hr_rest::employee_facets))
        .route(HR_ORG_CHART_PATH, get(get_hr_org_chart))
        .route(HR_LEAVE_BALANCES_PATH, get(list_leave_balances))
        .route(HR_ATTENDANCE_SUMMARY_PATH, get(list_attendance_summary))
        .route(HR_READINESS_SUMMARY_PATH, get(get_hr_readiness_summary))
        .route(
            HR_ABSENCE_EXIT_DASHBOARD_PATH,
            get(get_absence_exit_dashboard),
        )
        .route(
            HR_EXIT_CASES_PATH,
            get(list_employee_exit_cases).post(report_employee_exit_case),
        )
        .route(HR_EXIT_CASE_PATH_TEMPLATE, get(get_employee_exit_case))
        .route(
            HR_EXIT_CASE_CONFIRM_PATH_TEMPLATE,
            post(confirm_employee_exit_case),
        )
        .route(
            HR_EXIT_CASE_REJECT_PATH_TEMPLATE,
            post(reject_employee_exit_case),
        )
        .route(
            HR_EXIT_CASE_CANCEL_PATH_TEMPLATE,
            post(cancel_employee_exit_case),
        )
        .route(
            HR_EXIT_CASE_APPROVAL_DRAFT_PATH_TEMPLATE,
            post(draft_employee_exit_approval),
        )
        .route(
            HR_ATTENDANCE_IMPORT_PREVIEW_PATH,
            post(preview_attendance_import).layer(DefaultBodyLimit::max(max_import_body())),
        )
        .route(
            HR_ATTENDANCE_IMPORT_DRY_RUN_PATH_TEMPLATE,
            post(dry_run_attendance_import),
        )
        .route(
            HR_ATTENDANCE_IMPORT_APPLY_PATH_TEMPLATE,
            post(apply_attendance_import),
        )
        .route(
            HR_ATTENDANCE_IMPORT_SUMMARY_PATH,
            get(list_attendance_import_summary),
        )
        .route(
            HR_MY_ATTENDANCE_RECORDS_PATH,
            get(list_my_attendance_records).post(create_my_attendance_record),
        )
        .route(HR_ATTENDANCE_RECORDS_PATH, get(list_attendance_records))
        .route(
            EMPLOYEES_IMPORT_PATH,
            post(import_employees).layer(DefaultBodyLimit::max(max_import_body())),
        )
        .route(
            EMPLOYEES_IMPORT_PREVIEW_PATH,
            post(preview_employee_import).layer(DefaultBodyLimit::max(max_import_body())),
        )
        .route(
            EMPLOYEES_IMPORT_DRY_RUN_PATH_TEMPLATE,
            post(dry_run_employee_import),
        )
        .route(
            EMPLOYEES_IMPORT_APPLY_PATH_TEMPLATE,
            post(apply_employee_import).get(employee_import_apply_job),
        )
        .route(EMPLOYEES_IMPORT_UNPLACED_PATH, get(list_import_unplaced))
        .route(
            EMPLOYEES_EXPORT_CSV_PATH,
            get(console_hr_rest::export_employees_csv),
        )
        .route(
            EMPLOYEE_LIFECYCLE_EVENTS_PATH_TEMPLATE,
            get(list_employee_lifecycle_events).post(create_employee_lifecycle_event),
        )
        .route(
            EMPLOYEES_LIFECYCLE_BULK_PATH,
            post(create_bulk_employee_lifecycle_events),
        )
        .route(
            EMPLOYEE_LIFECYCLE_EVENT_CANCEL_PATH_TEMPLATE,
            post(cancel_employee_lifecycle_event),
        )
        .route(
            EMPLOYEE_HOME_BRANCH_PATH_TEMPLATE,
            put(set_employee_home_branch),
        )
        .with_state(state);
    let router = lane_routes::merge(router, &lanes);
    console_platform_request_context::with_request_context(router, verifier, pool)
}

#[derive(Debug, Serialize)]
struct LeaveBalancePage {
    items: Vec<LeaveBalanceItem>,
    total: i64,
    limit: i64,
    offset: i64,
    summary: LeaveBalanceSummary,
}

#[derive(Debug, Serialize)]
struct LeaveBalanceItem {
    id: Uuid,
    company: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    employee_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    position: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_accrued: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_used: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    leave_remaining: Option<String>,
}

#[derive(Debug, Serialize)]
struct LeaveBalanceSummary {
    accrued: String,
    used: String,
    remaining: String,
}

#[derive(Debug, Serialize)]
struct AttendanceSummaryPage {
    items: Vec<AttendanceSummaryItem>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Serialize)]
struct AttendanceSummaryItem {
    user_id: Uuid,
    display_name: String,
    arrivals: i64,
    departures: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_event_at: Option<time::OffsetDateTime>,
}
#[derive(Debug, Deserialize)]
struct AttendanceSummaryQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    branch_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct AttendanceManagerRecordsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    employee_id: Option<Uuid>,
    branch_id: Option<Uuid>,
}

#[derive(Debug, Deserialize)]
struct AttendanceSelfRecordsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Serialize)]
struct EmployeeAttendanceRecordPage {
    items: Vec<EmployeeAttendanceRecordResponse>,
    total: i64,
    limit: i64,
    offset: i64,
}

#[derive(Debug, Clone, Serialize)]
struct EmployeeAttendanceRecordResponse {
    id: Uuid,
    employee_id: Uuid,
    employee_display_name: String,
    kind: String,
    occurred_at: time::OffsetDateTime,
    work_date: String,
    state_after: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
    payroll_material_ref_id: Uuid,
    payroll_link_status: String,
    duplicate: bool,
}

#[derive(Debug, Clone)]
struct LinkedEmployee {
    employee_id: Uuid,
    display_name: String,
}

#[derive(Debug, Serialize)]
struct HrReadinessSummary {
    imports: HrImportReadinessSummary,
    payroll: HrPayrollReadinessSummary,
    annual_leave: HrAnnualLeaveReadinessSummary,
    attendance: HrAttendanceReadinessSummary,
}

#[derive(Debug, Serialize)]
struct HrImportReadinessSummary {
    runs: i64,
    applied_runs: i64,
    input_rows: i64,
    candidate_rows: i64,
    preserved_rows: i64,
    ledger_rows: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_import_at: Option<time::OffsetDateTime>,
}

#[derive(Debug, Serialize)]
struct HrPayrollReadinessSummary {
    draft_runs: i64,
    blocked_runs: i64,
    calculation_enabled_runs: i64,
    active_close_runs: i64,
    draft_lines: i64,
    payroll_source_rows: i64,
    attendance_source_rows: i64,
    attendance_event_links: i64,
    attendance_material_refs: i64,
    gross_pay_source_lines: i64,
    net_pay_source_lines: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_source_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_period_start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_period_end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    latest_updated_at: Option<time::OffsetDateTime>,
}

#[derive(Debug, Serialize)]
struct HrAnnualLeaveReadinessSummary {
    obligations: i64,
    usage_promotion_required: i64,
    payout_review_required: i64,
    needs_review: i64,
    remaining_days: String,
}

#[derive(Debug, Serialize)]
struct HrAttendanceReadinessSummary {
    durable_events: i64,
    self_service_records: i64,
    payroll_material_refs: i64,
}

#[derive(Debug, Deserialize)]
struct HrListQuery {
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct AbsenceExitDashboardQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    #[serde(default)]
    employee_id: Option<Uuid>,
}

#[derive(Debug, Serialize)]
struct AbsenceExitDashboardResponse {
    summary: AbsenceExitSummary,
    alerts: Vec<EmployeeAbsenceAlertResponse>,
    exit_cases: Vec<EmployeeExitCaseResponse>,
}

#[derive(Debug, Serialize)]
struct AbsenceExitSummary {
    open_absence_alerts: i64,
    exit_cases_pending_hr: i64,
    settlement_needs_source: i64,
    settlement_ready: i64,
    approval_drafts: i64,
    submitted: i64,
}

#[derive(Debug, Serialize)]
struct EmployeeAbsenceAlertResponse {
    id: Uuid,
    employee_id: Uuid,
    employee_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    employee_number: Option<String>,
    company: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    org_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worksite_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch_name: Option<String>,
    work_date: String,
    source: String,
    status: String,
    severity: String,
    audience_roles: Vec<String>,
    signal_payload: Value,
    notification_title: String,
    notification_message: String,
    link_href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_case_id: Option<Uuid>,
    #[serde(with = "time::serde::rfc3339")]
    detected_at: OffsetDateTime,
}

async fn list_employees(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<EmployeeListQuery>,
) -> Result<Json<EmployeePage>, HrApiError> {
    Ok(Json(state.hr.list_employees(principal, query).await?))
}

async fn create_employee(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateEmployeeRequest>,
) -> Result<(StatusCode, Json<EmployeeDetailResponse>), HrApiError> {
    // AX-5: the adapter decides the place over the grant set.
    // Fail closed BEFORE any write: the home-branch routing authority is
    // command-only (0166) and must be assignable for the created employee.
    let command_store = require_home_branch_command_store(&state)?;
    let (status, detail) = state
        .hr
        .create_employee(principal, command_store, body)
        .await?;
    Ok((status, Json(detail)))
}

/// The home-branch command capability both employee-creating surfaces
/// (People & Workforce create, recruiting hire) must hold BEFORE writing.
pub(crate) fn require_home_branch_command_store(state: &HrState) -> Result<PgLeaveStore, HrError> {
    state
        .leave_command_store
        .clone()
        .filter(PgLeaveStore::has_leave_command_pool)
        .ok_or_else(|| {
            HrError::unavailable(
                "leave command database is not configured; employee creation requires the home-branch command capability",
            )
        })
}

async fn get_employee_detail(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
) -> Result<Json<EmployeeDetailResponse>, HrApiError> {
    Ok(Json(
        state.hr.employee_detail(principal, employee_id).await?,
    ))
}

/// Assign the employee's authoritative approval-routing branch. No inference is
/// accepted: the caller names one active branch and must have manage authority
/// over both that branch and the employee's prior home branch (when present).
/// The row mutation and its before/after audit snapshots commit atomically.
async fn set_employee_home_branch(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    Json(body): Json<SetEmployeeHomeBranchRequest>,
) -> Result<Json<EmployeeHomeBranchResponse>, HrApiError> {
    authorize(
        &principal,
        Action::new(Feature::EmployeeDirectoryManage),
        BranchId::from_uuid(body.branch_id),
    )
    .map_err(HrError::from_kernel)?;

    let command_store = state.leave_command_store.clone().ok_or_else(|| {
        HrError::unavailable(
            "leave command database is not configured; home-branch assignment is unavailable",
        )
    })?;

    Ok(Json(
        state
            .hr
            .set_home_branch(principal, command_store, employee_id, body)
            .await?,
    ))
}

async fn get_hr_org_chart(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<HrOrgChartResponse>, HrApiError> {
    Ok(Json(state.hr.org_chart(principal).await?))
}

async fn list_leave_balances(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<HrListQuery>,
) -> Result<Json<LeaveBalancePage>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("leave_balances");
    let org = principal.org_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total, summary) = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let total: i64 = sqlx::query_scalar(
                r#"
                SELECT count(*)
                FROM employees
                WHERE leave_accrued IS NOT NULL
                   OR leave_used IS NOT NULL
                   OR leave_remaining IS NOT NULL
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let summary_row = sqlx::query(
                r#"
                SELECT
                    COALESCE(SUM(leave_accrued), 0)::TEXT AS accrued,
                    COALESCE(SUM(leave_used), 0)::TEXT AS used,
                    COALESCE(SUM(leave_remaining), 0)::TEXT AS remaining
                FROM employees
                WHERE leave_accrued IS NOT NULL
                   OR leave_used IS NOT NULL
                   OR leave_remaining IS NOT NULL
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;
            let summary = LeaveBalanceSummary {
                accrued: summary_row.try_get("accrued")?,
                used: summary_row.try_get("used")?,
                remaining: summary_row.try_get("remaining")?,
            };

            let items = sqlx::query(
                r#"
                SELECT
                    id,
                    company,
                    name,
                    employee_number,
                    org_unit,
                    position,
                    leave_accrued::TEXT AS leave_accrued,
                    leave_used::TEXT AS leave_used,
                    leave_remaining::TEXT AS leave_remaining
                FROM employees
                WHERE leave_accrued IS NOT NULL
                   OR leave_used IS NOT NULL
                   OR leave_remaining IS NOT NULL
                ORDER BY company ASC, name ASC, source_sheet ASC, source_row ASC
                LIMIT $1 OFFSET $2
                "#,
            )
            .bind(limit)
            .bind(offset)
            .fetch_all(tx.as_mut())
            .await?
            .into_iter()
            .map(|row| {
                Ok(LeaveBalanceItem {
                    id: row.try_get("id")?,
                    company: row.try_get("company")?,
                    name: row.try_get("name")?,
                    employee_number: row.try_get("employee_number")?,
                    org_unit: row.try_get("org_unit")?,
                    position: row.try_get("position")?,
                    leave_accrued: row.try_get("leave_accrued")?,
                    leave_used: row.try_get("leave_used")?,
                    leave_remaining: row.try_get("leave_remaining")?,
                })
            })
            .collect::<Result<Vec<_>, HrError>>()?;

            Ok((items, total, summary))
        })
    })
    .await?;

    Ok(Json(LeaveBalancePage {
        items,
        total,
        limit,
        offset,
        summary,
    }))
}

async fn list_attendance_summary(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AttendanceSummaryQuery>,
) -> Result<Json<AttendanceSummaryPage>, HrApiError> {
    let scope = authorize_hr_attendance_branch_query(
        &principal,
        Feature::EmployeeDirectoryRead,
        query.branch_id,
    )?;
    record_hr_read("attendance_summary");
    let org = principal.org_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total) = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let mut total_query = QueryBuilder::<Postgres>::new(
                "SELECT COUNT(*) FROM (SELECT l.user_id FROM site_attendance_events l WHERE ",
            );
            push_attendance_branch_filter(&mut total_query, scope);
            total_query.push(" GROUP BY l.user_id) counted");
            let total: i64 = total_query
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await?;

            let mut rows_query = QueryBuilder::<Postgres>::new(
                r#"
                SELECT
                    l.user_id,
                    COALESCE(u.display_name, '사용자 미확인') AS display_name,
                    COUNT(*) FILTER (WHERE l.kind = 'ARRIVAL') AS arrivals,
                    COUNT(*) FILTER (WHERE l.kind = 'DEPARTURE') AS departures,
                    (ARRAY_AGG(l.kind ORDER BY l.occurred_at DESC))[1] AS last_kind,
                    MAX(l.occurred_at) AS last_event_at
                FROM site_attendance_events l
                LEFT JOIN users u ON u.id = l.user_id
                WHERE
                "#,
            );
            push_attendance_branch_filter(&mut rows_query, scope);
            rows_query.push(
                " GROUP BY l.user_id, u.display_name ORDER BY last_event_at DESC, l.user_id DESC LIMIT ",
            );
            rows_query.push_bind(limit);
            rows_query.push(" OFFSET ");
            rows_query.push_bind(offset);

            let items = rows_query
                .build()
                .fetch_all(tx.as_mut())
                .await?
                .into_iter()
                .map(|row| {
                    Ok(AttendanceSummaryItem {
                        user_id: row.try_get("user_id")?,
                        display_name: row.try_get("display_name")?,
                        arrivals: row.try_get("arrivals")?,
                        departures: row.try_get("departures")?,
                        last_kind: row.try_get("last_kind")?,
                        last_event_at: row.try_get("last_event_at")?,
                    })
                })
                .collect::<Result<Vec<_>, HrError>>()?;

            Ok((items, total))
        })
    })
    .await?;

    Ok(Json(AttendanceSummaryPage {
        items,
        total,
        limit,
        offset,
    }))
}
async fn list_my_attendance_records(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AttendanceSelfRecordsQuery>,
) -> Result<Json<EmployeeAttendanceRecordPage>, HrApiError> {
    record_hr_read("employee_attendance_self");
    let org = principal.org_id;
    let user_id = principal.user_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let page = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            // Self-scoped read, no role gate: an authenticated user with no
            // linked employee — an ADMIN/system account — has zero personal
            // records, so return an empty page rather than a 403. (Writes still
            // require a link via `load_linked_employee_for_user`.)
            match load_optional_linked_employee_id(tx, org, user_id).await? {
                Some(employee_id) => {
                    list_attendance_records_for_employee(tx, employee_id, None, limit, offset).await
                }
                None => Ok(EmployeeAttendanceRecordPage {
                    items: Vec::new(),
                    total: 0,
                    limit,
                    offset,
                }),
            }
        })
    })
    .await?;

    Ok(Json(page))
}

async fn list_attendance_records(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AttendanceManagerRecordsQuery>,
) -> Result<Json<EmployeeAttendanceRecordPage>, HrApiError> {
    let branch_id = authorize_hr_attendance_branch_query(
        &principal,
        Feature::EmployeeDirectoryRead,
        query.branch_id,
    )?;
    record_hr_read("employee_attendance_management");
    let org = principal.org_id;
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);
    let employee_id = query.employee_id;

    let page = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            if let Some(employee_id) = employee_id {
                list_attendance_records_for_employee(tx, employee_id, branch_id, limit, offset)
                    .await
            } else {
                list_attendance_records_for_org(tx, branch_id, limit, offset).await
            }
        })
    })
    .await?;

    Ok(Json(page))
}

async fn create_my_attendance_record(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Json(body): Json<CreateEmployeeAttendanceRecordRequest>,
) -> Result<Json<EmployeeAttendanceRecordResponse>, HrApiError> {
    let org = principal.org_id;
    let actor = principal.user_id;
    let kind = normalize_attendance_kind(&body.kind)?;
    let idempotency_key = normalize_idempotency_key(body.idempotency_key)?;
    let note = normalize_attendance_note(body.note)?;

    let response = with_audits::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let linked = load_linked_employee_for_user(tx, org, actor, true).await?;

            if let Some(existing) =
                load_attendance_record_by_idempotency_key(tx, linked.employee_id, &idempotency_key)
                    .await?
            {
                if existing.kind.as_str() != kind || existing.note != note {
                    return Err(HrError::from_kernel(KernelError::conflict(
                        "idempotency key already used with different attendance payload",
                    )));
                }
                return Ok((existing, Vec::new()));
            }

            let previous_state: Option<String> = sqlx::query_scalar(
                r#"
                SELECT state_after
                FROM employee_attendance_records
                WHERE employee_id = $1
                ORDER BY occurred_at DESC, created_at DESC, id DESC
                LIMIT 1
                "#,
            )
            .bind(linked.employee_id)
            .fetch_optional(tx.as_mut())
            .await?;
            let state_after = next_employee_attendance_state(previous_state.as_deref(), kind)?;

            let record_row = sqlx::query(
                r#"
                INSERT INTO employee_attendance_records (
                    org_id,
                    employee_id,
                    actor_user_id,
                    kind,
                    state_after,
                    note,
                    idempotency_key
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING
                    id,
                    employee_id,
                    kind,
                    occurred_at,
                    work_date::TEXT AS work_date,
                    state_after,
                    note
                "#,
            )
            .bind(*org.as_uuid())
            .bind(linked.employee_id)
            .bind(*actor.as_uuid())
            .bind(kind)
            .bind(state_after)
            .bind(note)
            .bind(&idempotency_key)
            .fetch_one(tx.as_mut())
            .await?;

            let record_id: Uuid = record_row.try_get("id")?;
            let work_date: String = record_row.try_get("work_date")?;
            let digest = sha256_hex(
                format!(
                    "employee_self_service|{}|{}|{}|{}",
                    org.as_uuid(),
                    linked.employee_id,
                    record_id,
                    kind
                )
                .as_bytes(),
            );

            // Freeze-window gate: an attendance write that stamps a work_date
            // inside a locked payroll period must fail closed (rolls back the
            // whole attendance record + material-ref transaction, 409).
            let work_date_parsed = Date::parse(
                &work_date,
                &time::format_description::well_known::Iso8601::DATE,
            )
            .map_err(|e| {
                HrError::from_kernel(KernelError::internal(format!(
                    "attendance work_date unparseable: {e}"
                )))
            })?;
            console_platform_db::assert_period_open(
                tx,
                console_platform_db::PeriodLockDomain::Payroll,
                work_date_parsed,
            )
            .await
            .map_err(HrError::from_kernel)?;

            let ref_id: Uuid = sqlx::query_scalar(
                r#"
                INSERT INTO payroll_attendance_material_refs (
                    org_id,
                    attendance_record_id,
                    employee_id,
                    work_date,
                    source_digest
                )
                VALUES ($1, $2, $3, $4::DATE, $5)
                RETURNING id
                "#,
            )
            .bind(*org.as_uuid())
            .bind(record_id)
            .bind(linked.employee_id)
            .bind(&work_date)
            .bind(digest)
            .fetch_one(tx.as_mut())
            .await?;

            let response = employee_attendance_record_from_parts(
                record_row,
                linked.display_name,
                ref_id,
                false,
            )?;

            let attendance_audit = AuditEvent::new(
                Some(actor),
                AuditAction::new("employee_attendance.record").map_err(HrError::from_kernel)?,
                "employee_attendance_record",
                record_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "employee_id": linked.employee_id,
                    "kind": response.kind,
                    "state_after": response.state_after,
                    "work_date": response.work_date,
                    "payroll_material_ref_id": ref_id,
                })),
            );
            let payroll_audit = AuditEvent::new(
                Some(actor),
                AuditAction::new("payroll_attendance.link").map_err(HrError::from_kernel)?,
                "payroll_attendance_material_ref",
                ref_id.to_string(),
                TraceContext::generate(),
                OffsetDateTime::now_utc(),
            )
            .with_org(org)
            .with_snapshots(
                None,
                Some(json!({
                    "attendance_record_id": record_id,
                    "employee_id": linked.employee_id,
                    "work_date": response.work_date,
                    "source_type": "employee_self_service",
                })),
            );

            Ok((response, vec![attendance_audit, payroll_audit]))
        })
    })
    .await?;

    Ok(Json(response))
}

async fn get_hr_readiness_summary(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<HrReadinessSummary>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("readiness_summary");
    let org = principal.org_id;
    let scope = principal.branch_scope.clone();

    let summary = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let import_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS runs,
                    COUNT(*) FILTER (WHERE status = 'APPLIED')::BIGINT AS applied_runs,
                    COALESCE(SUM(input_rows), 0)::BIGINT AS input_rows,
                    COALESCE(SUM(candidate_rows), 0)::BIGINT AS candidate_rows,
                    COALESCE(SUM(preserved_rows), 0)::BIGINT AS preserved_rows,
                    MAX(COALESCE(applied_at, updated_at, created_at)) AS latest_import_at
                FROM data_import_runs
                WHERE entity_type = 'employee_hr'
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let ledger_rows: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)::BIGINT
                FROM data_import_rows r
                JOIN data_import_runs run
                  ON run.id = r.run_id
                 AND run.org_id = r.org_id
                WHERE run.entity_type = 'employee_hr'
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let payroll_run_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS draft_runs,
                    COUNT(*) FILTER (WHERE status = 'BLOCKED_LEGAL_GATE')::BIGINT AS blocked_runs,
                    COUNT(*) FILTER (WHERE calculation_enabled)::BIGINT AS calculation_enabled_runs,
                    -- Inspectable close states are STAGED, BLOCKED_LEGAL_GATE,
                    -- READY_FOR_REVIEW, and APPROVED. ISSUED and VOID are terminal history.
                    COUNT(*) FILTER (
                        WHERE status IN ('STAGED', 'BLOCKED_LEGAL_GATE', 'READY_FOR_REVIEW', 'APPROVED')
                    )::BIGINT AS active_close_runs,
                    (ARRAY_AGG(status ORDER BY updated_at DESC, id DESC))[1] AS latest_status,
                    (ARRAY_AGG(source_label ORDER BY updated_at DESC, id DESC))[1] AS latest_source_label,
                    (ARRAY_AGG(period_start::TEXT ORDER BY updated_at DESC, id DESC))[1] AS latest_period_start,
                    (ARRAY_AGG(period_end::TEXT ORDER BY updated_at DESC, id DESC))[1] AS latest_period_end,
                    MAX(updated_at) AS latest_updated_at
                FROM payroll_draft_runs
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let payroll_line_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS draft_lines,
                    COALESCE(SUM(payroll_source_row_count), 0)::BIGINT AS payroll_source_rows,
                    COALESCE(SUM(attendance_source_row_count), 0)::BIGINT AS attendance_source_rows,
                    COALESCE(SUM(attendance_event_count), 0)::BIGINT AS attendance_event_links,
                    COUNT(*) FILTER (WHERE gross_pay_source_present)::BIGINT AS gross_pay_source_lines,
                    COUNT(*) FILTER (WHERE net_pay_source_present)::BIGINT AS net_pay_source_lines
                FROM payroll_draft_lines
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let leave_row = sqlx::query(
                r#"
                SELECT
                    COUNT(*)::BIGINT AS obligations,
                    COUNT(*) FILTER (WHERE status = 'USAGE_PROMOTION_DRAFT_REQUIRED')::BIGINT AS usage_promotion_required,
                    COUNT(*) FILTER (WHERE status = 'PAYOUT_REVIEW_REQUIRED')::BIGINT AS payout_review_required,
                    COUNT(*) FILTER (WHERE status = 'NEEDS_HR_REVIEW')::BIGINT AS needs_review,
                    COALESCE(SUM(leave_remaining), 0)::TEXT AS remaining_days
                FROM annual_leave_obligations
                "#,
            )
            .fetch_one(tx.as_mut())
            .await?;

            let mut attendance_query =
                QueryBuilder::<Postgres>::new("SELECT COUNT(*)::BIGINT FROM site_attendance_events l WHERE ");
            push_attendance_branch_scope(&mut attendance_query, &scope);
            let durable_events: i64 = attendance_query
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await?;
            let self_service_records: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::BIGINT FROM employee_attendance_records",
            )
            .fetch_one(tx.as_mut())
            .await?;
            let attendance_material_refs: i64 = sqlx::query_scalar(
                "SELECT COUNT(*)::BIGINT FROM payroll_attendance_material_refs",
            )
            .fetch_one(tx.as_mut())
            .await?;


            Ok(HrReadinessSummary {
                imports: HrImportReadinessSummary {
                    runs: import_row.try_get("runs")?,
                    applied_runs: import_row.try_get("applied_runs")?,
                    input_rows: import_row.try_get("input_rows")?,
                    candidate_rows: import_row.try_get("candidate_rows")?,
                    preserved_rows: import_row.try_get("preserved_rows")?,
                    ledger_rows,
                    latest_import_at: import_row.try_get("latest_import_at")?,
                },
                payroll: HrPayrollReadinessSummary {
                    draft_runs: payroll_run_row.try_get("draft_runs")?,
                    blocked_runs: payroll_run_row.try_get("blocked_runs")?,
                    calculation_enabled_runs: payroll_run_row
                        .try_get("calculation_enabled_runs")?,
                    active_close_runs: payroll_run_row.try_get("active_close_runs")?,
                    draft_lines: payroll_line_row.try_get("draft_lines")?,
                    payroll_source_rows: payroll_line_row.try_get("payroll_source_rows")?,
                    attendance_source_rows: payroll_line_row
                        .try_get("attendance_source_rows")?,
                    attendance_event_links: payroll_line_row.try_get("attendance_event_links")?,
                    attendance_material_refs,
                    gross_pay_source_lines: payroll_line_row
                        .try_get("gross_pay_source_lines")?,
                    net_pay_source_lines: payroll_line_row.try_get("net_pay_source_lines")?,
                    latest_status: payroll_run_row.try_get("latest_status")?,
                    latest_source_label: payroll_run_row.try_get("latest_source_label")?,
                    latest_period_start: payroll_run_row.try_get("latest_period_start")?,
                    latest_period_end: payroll_run_row.try_get("latest_period_end")?,
                    latest_updated_at: payroll_run_row.try_get("latest_updated_at")?,
                },
                annual_leave: HrAnnualLeaveReadinessSummary {
                    obligations: leave_row.try_get("obligations")?,
                    usage_promotion_required: leave_row
                        .try_get("usage_promotion_required")?,
                    payout_review_required: leave_row.try_get("payout_review_required")?,
                    needs_review: leave_row.try_get("needs_review")?,
                    remaining_days: leave_row.try_get("remaining_days")?,
                },
                attendance: HrAttendanceReadinessSummary {
                    durable_events,
                    self_service_records,
                    payroll_material_refs: attendance_material_refs,
                },
            })
        })
    })
    .await?;

    Ok(Json(summary))
}

async fn get_absence_exit_dashboard(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<AbsenceExitDashboardQuery>,
) -> Result<Json<AbsenceExitDashboardResponse>, HrApiError> {
    authorize_hr_scoped(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("absence_exit_dashboard");
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let scope = principal.branch_scope.clone();
    let actor = principal.user_id;
    let reader = principal.clone();
    let limit = query.limit.unwrap_or(50).clamp(1, 200);
    let offset = query.offset.unwrap_or(0).max(0);
    let employee_id = query.employee_id;

    // `with_audits` (not `with_org_conn`): the read-path materializer mutates the
    // audited `employee_absence_alerts` table, so a changed pass must land an
    // audit row in the SAME transaction (0093 review MEDIUM #5). It emits ZERO
    // events on an unchanged read, so the materializer's idempotency/write-storm
    // guard is preserved — no audit spam on repeated dashboard GETs.
    let dashboard = with_audits::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let changed_alert_ids =
                materialize_absence_alerts_from_imports(tx, org_uuid, &scope).await?;
            let summary = load_absence_exit_summary(tx, &scope).await?;
            let alerts = load_absence_alerts(tx, &scope, employee_id, limit, offset).await?;
            let filters = ExitCaseFilters {
                employee_id,
                ..ExitCaseFilters::default()
            };
            let exit_cases = load_exit_cases(tx, &scope, &filters, limit, offset).await?;
            let mut subjects: Vec<Uuid> = alerts.iter().map(|alert| alert.employee_id).collect();
            subjects.extend(exit_cases.iter().map(|case| case.employee_id));
            subjects.sort_unstable();
            subjects.dedup();
            let me = actor_employee_id(tx, &reader).await?;
            let surface = json!({ "surface": "absence_exit_dashboard" });
            let read = access_event(
                &reader,
                DirectoryAccess::ExitCaseList,
                &subjects,
                me,
                surface,
            );
            let mut events = vec![read?];
            if !changed_alert_ids.is_empty() {
                events.push(
                    AuditEvent::new(
                        Some(actor),
                        AuditAction::new("employee.absence_alert.materialize")
                            .map_err(HrError::from_kernel)?,
                        "employee_absence_alerts",
                        org_uuid.to_string(),
                        TraceContext::generate(),
                        OffsetDateTime::now_utc(),
                    )
                    .with_org(org)
                    .with_snapshots(
                        None,
                        Some(json!({
                            "changed_count": changed_alert_ids.len(),
                            "changed_alert_ids": changed_alert_ids,
                            "source": "attendance_direct_import",
                            "trigger": "absence_exit_dashboard_read",
                        })),
                    ),
                );
            }

            Ok((
                AbsenceExitDashboardResponse {
                    summary,
                    alerts,
                    exit_cases: exit_cases
                        .into_iter()
                        .map(|c| c.for_reader(&reader))
                        .collect(),
                },
                events,
            ))
        })
    })
    .await?;

    Ok(Json(dashboard))
}

/// `GET /api/v1/hr/exit-cases?employee_id=&status=&limit=&offset=`: exit cases
/// inside the caller's branch scope, newest activity first, with the filtered
/// `total`. Same read gate as the absence/exit dashboard.
async fn list_employee_exit_cases(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<ExitCaseListQuery>,
) -> Result<Json<EmployeeExitCasePage>, HrApiError> {
    Ok(Json(state.hr.list_exit_cases(principal, query).await?))
}

/// `GET /api/v1/hr/exit-cases/{id}`: one case; outside the caller's branch
/// scope it is 404 like an absent one (deny by omission).
async fn get_employee_exit_case(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(case_id): Path<Uuid>,
) -> Result<Json<EmployeeExitCaseResponse>, HrApiError> {
    let store = console_compliance_adapter_postgres::PgComplianceStore::new(state.pool.clone());
    let register = store.statutory_register().await;
    let register = register.map_err(|e| HrError::internal(e.to_string()))?;
    let case = state.hr.exit_case(principal, case_id, &register).await?;
    Ok(Json(case))
}

async fn report_employee_exit_case(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    headers: axum::http::HeaderMap,
    Json(body): Json<ReportEmployeeExitCaseRequest>,
) -> Result<(StatusCode, Json<Value>), HrApiError> {
    let idempotency_key = require_idempotency_key(&headers)?;
    let (status, response) = state
        .hr
        .report_exit_case(principal, idempotency_key, body)
        .await?;
    Ok((status, Json(response)))
}

// M2-strangler-debt: this absence->exit->settlement flow is a hardcoded cross-module
// decision spine (report -> HR confirm -> HQ confirm -> settlement -> approval). It is the
// SECOND such flow (after completion->approval->payroll) slated to migrate onto the ADR-0018
// workflow runtime spine (workflow_runs / workflow_node_runs / workflow_waiting_tasks /
// workflow_outbox_events). State machine -> spine-IR mapping: exit_case.status transitions map
// to workflow_node_runs; the two-tier confirm maps to workflow_waiting_tasks with required_policy
// guards; the settlement/certification side effects map to idempotency-keyed workflow_outbox_events.
// See .omc/plans/ralplan-pr166-completion.md S8.2 (M2 charter follow-up). Migration is mechanical,
// not a rewrite, once the M2 executor lands.
async fn confirm_employee_exit_case(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(case_id): Path<Uuid>,
    Json(body): Json<ConfirmEmployeeExitCaseRequest>,
) -> Result<Json<EmployeeExitCaseResponse>, HrApiError> {
    let (hr, pk) = (&state.hr, state.passkey_step_up.as_ref());
    let case = hr.confirm_exit_case(principal, pk, case_id, body).await?;
    Ok(Json(case))
}

/// `POST /hr/exit-cases/{id}/reject`: a reviewer refuses the exit. Allowed from
/// every open state (REPORTED through APPROVAL_DRAFTED) to a holder of either
/// exit-confirmation capability; `reason` is required.
async fn reject_employee_exit_case(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(case_id): Path<Uuid>,
    Json(body): Json<CloseEmployeeExitCaseRequest>,
) -> Result<Json<EmployeeExitCaseResponse>, HrApiError> {
    let case = state
        .hr
        .close_exit_case(principal, case_id, body, "REJECTED");
    Ok(Json(case.await?))
}

/// `POST /hr/exit-cases/{id}/cancel`: the report is withdrawn before HQ
/// confirmation (REPORTED or HR_CONFIRMED). The reporter's capability suffices
/// while REPORTED; once HR confirmed it takes the HR confirmation capability.
async fn cancel_employee_exit_case(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(case_id): Path<Uuid>,
    Json(body): Json<CloseEmployeeExitCaseRequest>,
) -> Result<Json<EmployeeExitCaseResponse>, HrApiError> {
    let case = state
        .hr
        .close_exit_case(principal, case_id, body, "CANCELLED");
    Ok(Json(case.await?))
}

async fn draft_employee_exit_approval(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(case_id): Path<Uuid>,
    Json(body): Json<DraftEmployeeExitApprovalRequest>,
) -> Result<Json<EmployeeExitCaseResponse>, HrApiError> {
    Ok(Json(
        state
            .hr
            .draft_exit_approval(principal, case_id, body)
            .await?,
    ))
}

async fn preview_attendance_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    multipart: Multipart,
) -> Result<Json<AttendanceImportPreviewResponse>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let caps = state.hr.workbook_caps(principal.org_id).await?;
    let upload = read_attendance_upload(multipart, caps.max_upload_bytes).await?;
    let source_sha256 = sha256_hex(&upload.bytes);
    let sheets = if upload.filename.to_ascii_lowercase().ends_with(".xlsx") {
        workbook_read::read_workbook_blocking(upload.bytes.clone(), caps).await?
    } else {
        Vec::new()
    };
    let parsed = parse_attendance_import_upload(&upload.filename, &upload.bytes, &sheets)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;
    let run_id = Uuid::new_v4();
    let input_rows = i32::try_from(parsed.rows.len())
        .map_err(|_| HrError::validation("attendance import row count exceeds i32"))?;
    let candidate_rows = i32::try_from(
        parsed
            .rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count(),
    )
    .map_err(|_| HrError::validation("attendance candidate row count exceeds i32"))?;
    let preserved_rows = i32::try_from(
        parsed
            .rows
            .iter()
            .filter(|row| row.row_status != ImportRowStatus::Candidate)
            .count(),
    )
    .map_err(|_| HrError::validation("attendance error row count exceeds i32"))?;
    let filename = upload.filename.clone();
    let source_format = attendance_source_format(&filename)?;
    let columns = attendance_import_columns_from_rows(&parsed.rows);
    let mapping_profile = attendance_import_mapping_profile(&columns);
    let audit_after = json!({
        "run_id": run_id,
        "entity_type": "attendance_direct",
        "source_filename": &filename,
        "source_sha256": &source_sha256,
        "input_rows": input_rows,
        "candidate_rows": candidate_rows,
        "preserved_rows": preserved_rows,
        "sensitive_values_returned": false,
        "payroll_effect": "lineage_only_not_payable"
    });
    let event = import_rows_event(&principal, "attendance_import.preview", run_id, audit_after)?;

    let preview = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        let filename = filename.clone();
        let pay_period_start = upload.pay_period_start;
        let pay_period_end = upload.pay_period_end;
        let source_sha256 = source_sha256.clone();
        let parsed = parsed.clone();
        let mapping_profile = mapping_profile.clone();
        Box::pin(async move {
            sqlx::query(
                r#"
                INSERT INTO data_import_runs (
                    id, org_id, entity_type, status, source_filename, source_format,
                    source_sha256, mapping_profile, input_rows, candidate_rows,
                    preserved_rows, created_by, pay_period_start, pay_period_end
                )
                VALUES ($1, $2, 'attendance_direct', 'PREVIEWED', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                "#,
            )
            .bind(run_id)
            .bind(org_uuid)
            .bind(&filename)
            .bind(source_format)
            .bind(&source_sha256)
            .bind(&mapping_profile)
            .bind(input_rows)
            .bind(candidate_rows)
            .bind(preserved_rows)
            .bind(*actor.as_uuid())
            .bind(pay_period_start)
            .bind(pay_period_end)
            .execute(tx.as_mut())
            .await?;

            for row in &parsed.rows {
                sqlx::query(
                    r#"
                    INSERT INTO data_import_rows (
                        org_id, run_id, source_sheet, source_row, source_key,
                        row_status, raw_row, canonical_row, validation
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    "#,
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(&row.source_sheet)
                .bind(row.source_row)
                .bind(&row.source_key)
                .bind(row.row_status.as_str())
                .bind(&row.raw_row)
                .bind(attendance_canonical_row_json(row, &source_sha256))
                .bind(attendance_validation_json(row))
                .execute(tx.as_mut())
                .await?;
            }

            Ok(AttendanceImportPreviewResponse::from_rows(
                run_id,
                filename,
                source_sha256,
                parsed.rows,
            ))
        })
    })
    .await?;

    metrics::counter!("hr_attendance_import_runs_total", "stage" => "preview").increment(1);
    Ok(Json(preview))
}

async fn dry_run_attendance_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<AttendanceImportDryRunSummary>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();

    let after = json!({ "run_id": run_id, "entity_type": "attendance_direct" });
    let event = import_rows_event(&principal, "attendance_import.dry_run", run_id, after)?;

    let summary = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
        Box::pin(async move {
            let run = import_run_for_update(tx, org_uuid, run_id).await?;
            ensure_attendance_import_run(&run, &["PREVIEWED", "DRY_RUN"])?;
            let rows = load_attendance_import_rows(tx, org_uuid, run_id).await?;
            let summary = resolve_attendance_import_rows(tx, org_uuid, run_id, &run, &rows).await?;
            sqlx::query(
                r#"
                UPDATE data_import_runs
                SET status = 'DRY_RUN', dry_run_summary = $3, updated_at = now()
                WHERE org_id = $1 AND id = $2
                "#,
            )
            .bind(org_uuid)
            .bind(run_id)
            .bind(json!(&summary))
            .execute(tx.as_mut())
            .await?;
            Ok(summary)
        })
    })
    .await?;

    metrics::counter!("hr_attendance_import_runs_total", "stage" => "dry_run").increment(1);
    Ok(Json(summary))
}

async fn apply_attendance_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    body: Option<Json<ImportApplyRequest>>,
) -> Result<Json<AttendanceImportApplyReport>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let checklist_all_acknowledged = body.and_then(|Json(b)| b.checklist_all_acknowledged);
    let gate_outcome = evaluate_ingest_checklist_gate(checklist_all_acknowledged)?;
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let actor = principal.user_id;

    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("attendance_import.apply").map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "run_id": run_id,
            "entity_type": "attendance_direct",
            "gate_outcome": gate_outcome
        })),
    );

    let report = with_audit::<_, _, HrError>(&state.pool, event, |tx| {
            Box::pin(async move {
                let run = import_run_for_update(tx, org_uuid, run_id).await?;
                ensure_attendance_import_run(&run, &["DRY_RUN"])?;
                let rows = load_attendance_import_rows(tx, org_uuid, run_id).await?;
                let summary = resolve_attendance_import_rows(tx, org_uuid, run_id, &run, &rows).await?;
                if !summary.row_errors.is_empty() {
                    return Err(HrError::validation(
                        "cannot apply attendance import with unresolved or invalid rows",
                    ));
                }

                let mut inserted = 0usize;
                for row in summary.ready_rows_for_apply {
                    let insert_result = sqlx::query(
                        r#"
                        INSERT INTO attendance_direct_import_events (
                            org_id, run_id, import_row_id, employee_id, branch_id,
                            source_sheet, source_row, source_key, source_sha256,
                            employee_number, employee_name, branch_name, work_date,
                            check_in_at, check_out_at, minutes_worked, fact_key
                        )
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
                        ON CONFLICT (org_id, fact_key) DO NOTHING
                        "#,
                    )
                    .bind(org_uuid)
                    .bind(run_id)
                    .bind(row.import_row_id)
                    .bind(row.employee_id)
                    .bind(row.branch_id)
                    .bind(&row.source_sheet)
                    .bind(row.source_row)
                    .bind(&row.source_key)
                    .bind(&run.source_sha256)
                    .bind(&row.employee_number)
                    .bind(&row.employee_name)
                    .bind(&row.branch_name)
                    .bind(&row.work_date)
                    .bind(&row.check_in_at)
                    .bind(&row.check_out_at)
                    .bind(row.minutes_worked)
                    .bind(&row.fact_key)
                    .execute(tx.as_mut())
                    .await?;
                    inserted += usize::try_from(insert_result.rows_affected()).unwrap_or_default();
                }

                let report = AttendanceImportApplyReport {
                    run_id,
                    inserted,
                    skipped: summary.ready_rows.saturating_sub(inserted),
                    error_rows: 0,
                };
                sqlx::query(
                    r#"
                    UPDATE data_import_runs
                    SET status = 'APPLIED', apply_summary = $3, applied_by = $4,
                        applied_at = now(), updated_at = now()
                    WHERE org_id = $1 AND id = $2
                    "#,
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(json!(&report))
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                Ok(report)
            })
        })
    .await?;

    metrics::counter!("hr_attendance_import_runs_total", "stage" => "apply").increment(1);
    Ok(Json(report))
}

async fn list_attendance_import_summary(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<HrListQuery>,
) -> Result<Json<AttendanceImportSummaryPage>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead)?;
    record_hr_read("attendance_import_summary");
    let org = principal.org_id;
    let org_uuid = *org.as_uuid();
    let limit = query.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = query.offset.unwrap_or(0).max(0);

    let (items, total) = with_org_conn::<_, _, HrError>(&state.pool, org, move |tx| {
        Box::pin(async move {
            let total: i64 = sqlx::query_scalar(
                r#"
                SELECT COUNT(*)
                FROM data_import_runs
                WHERE org_id = $1 AND entity_type = 'attendance_direct'
                "#,
            )
            .bind(org_uuid)
            .fetch_one(tx.as_mut())
            .await?;

            let items = sqlx::query(
                r#"
                SELECT
                    id, status, source_filename, source_format, source_sha256,
                    input_rows, candidate_rows, preserved_rows,
                    dry_run_summary, apply_summary, created_at, applied_at
                FROM data_import_runs
                WHERE org_id = $1 AND entity_type = 'attendance_direct'
                ORDER BY created_at DESC, id DESC
                LIMIT $2 OFFSET $3
                "#,
            )
            .bind(org_uuid)
            .bind(limit)
            .bind(offset)
            .fetch_all(tx.as_mut())
            .await?
            .into_iter()
            .map(|row| {
                Ok(AttendanceImportSummaryItem {
                    run_id: row.try_get("id")?,
                    status: row.try_get("status")?,
                    source_filename: row.try_get("source_filename")?,
                    source_format: row.try_get("source_format")?,
                    source_sha256: row.try_get("source_sha256")?,
                    input_rows: row.try_get("input_rows")?,
                    candidate_rows: row.try_get("candidate_rows")?,
                    preserved_rows: row.try_get("preserved_rows")?,
                    dry_run_summary: row.try_get("dry_run_summary")?,
                    apply_summary: row.try_get("apply_summary")?,
                    created_at: row.try_get("created_at")?,
                    applied_at: row.try_get("applied_at")?,
                })
            })
            .collect::<Result<Vec<_>, HrError>>()?;

            Ok((items, total))
        })
    })
    .await?;

    Ok(Json(AttendanceImportSummaryPage {
        items,
        total,
        limit,
        offset,
    }))
}
async fn list_employee_lifecycle_events(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    Query(page): Query<LifecycleEventsQuery>,
    headers: axum::http::HeaderMap,
) -> Result<Json<EmployeeLifecycleEventPage>, HrApiError> {
    let korean = crate::error_i18n::prefers_korean(&headers);
    let page = state
        .hr
        .lifecycle_events(principal, employee_id, page, korean);
    Ok(Json(page.await?))
}

async fn create_employee_lifecycle_event(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(employee_id): Path<Uuid>,
    headers: axum::http::HeaderMap,
    Json(body): Json<CreateEmployeeLifecycleEventRequest>,
) -> Result<Json<Value>, HrApiError> {
    // AX-5: the adapter decides the person (and any target) over the grant set.
    let idempotency_key = require_idempotency_key(&headers)?;
    Ok(Json(
        state
            .hr
            .record_lifecycle_event(principal, employee_id, idempotency_key, body)
            .await?,
    ))
}

/// Applies the due SCHEDULED lifecycle events in every tenant; the body is
/// `HrService::apply_due` (R2-life). Kept for `lifecycle_schedule` and the
/// `console_app::apply_due_lifecycle_events` re-export.
pub async fn apply_due_lifecycle_events(pool: &PgPool, today: Date) -> Result<usize, String> {
    HrService::new(pool.clone()).apply_due(today).await
}

/// `POST /employees/{id}/lifecycle-events/{event_id}/cancel`: withdraw a
/// SCHEDULED event before its date. A scheduled exit belongs to its exit case
/// and is withdrawn by cancelling or rejecting that case.
async fn cancel_employee_lifecycle_event(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path((employee_id, event_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CancelLifecycleEventRequest>,
) -> Result<Json<EmployeeLifecycleEventResponse>, HrApiError> {
    Ok(Json(
        state
            .hr
            .cancel_lifecycle_event(principal, employee_id, event_id, body)
            .await?,
    ))
}

/// POST `/api/v1/employees/lifecycle-events/bulk`: one TRANSFER or PROMOTE for
/// up to 500 employees, all or nothing. Every employee is locked (in id order)
/// and validated by the single-event rules first; any refusal rolls the whole
/// batch back as one 422 naming every refused employee. Otherwise each event
/// is recorded exactly as the single-event endpoint records it (one
/// `employee.lifecycle.record` audit each) plus one `employee.lifecycle.bulk`
/// audit carrying the batch id.
/// With `Prefer: respond-async` it is a job (202, CAP-04; `lifecycle_bulk_job`).
async fn create_bulk_employee_lifecycle_events(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    headers: axum::http::HeaderMap,
    Json(body): Json<BulkEmployeeLifecycleEventRequest>,
) -> axum::response::Response {
    console_hr_rest::lifecycle_bulk_job::create(&state.hr, principal, &headers, body).await
}

fn require_idempotency_key(headers: &axum::http::HeaderMap) -> Result<String, HrError> {
    validate_idempotency_key(
        headers
            .get(IDEMPOTENCY_KEY_HEADER)
            .and_then(|value| value.to_str().ok()),
    )
    .map_err(HrError::validation)
}

#[derive(Debug, Clone, Serialize)]
struct AttendanceImportColumn {
    source_header: String,
    normalized_header: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    target: Option<String>,
    classification: String,
    preview_allowed: bool,
}

#[derive(Debug, Serialize)]
struct AttendanceImportPreviewRow {
    source_sheet: String,
    source_row: i32,
    row_status: String,
    values: BTreeMap<String, Value>,
    validation: Value,
}

#[derive(Debug, Serialize)]
struct AttendanceImportPreviewResponse {
    run_id: Uuid,
    entity_type: String,
    source_filename: String,
    source_sha256: String,
    input_rows: usize,
    candidate_rows: usize,
    preserved_rows: usize,
    columns: Vec<AttendanceImportColumn>,
    sample_rows: Vec<AttendanceImportPreviewRow>,
    mapping_profile: Value,
}

impl AttendanceImportPreviewResponse {
    fn from_rows(
        run_id: Uuid,
        source_filename: String,
        source_sha256: String,
        rows: Vec<ParsedAttendanceImportRow>,
    ) -> Self {
        let columns = attendance_import_columns_from_rows(&rows);
        let sample_rows = rows
            .iter()
            .take(12)
            .map(|row| AttendanceImportPreviewRow {
                source_sheet: row.source_sheet.clone(),
                source_row: row.source_row,
                row_status: row.row_status.as_str().to_owned(),
                values: attendance_preview_values(&row.raw_row, &columns),
                validation: attendance_validation_json(row),
            })
            .collect::<Vec<_>>();
        let input_rows = rows.len();
        let candidate_rows = rows
            .iter()
            .filter(|row| row.row_status == ImportRowStatus::Candidate)
            .count();
        let preserved_rows = rows
            .iter()
            .filter(|row| row.row_status != ImportRowStatus::Candidate)
            .count();

        Self {
            run_id,
            entity_type: "attendance_direct".to_owned(),
            source_filename,
            source_sha256,
            input_rows,
            candidate_rows,
            preserved_rows,
            columns: columns.clone(),
            sample_rows,
            mapping_profile: attendance_import_mapping_profile(&columns),
        }
    }
}

#[derive(Debug, Default, Serialize)]
struct AttendanceImportDryRunSummary {
    run_id: Uuid,
    input_rows: usize,
    candidate_rows: usize,
    preserved_rows: usize,
    ready_rows: usize,
    error_rows: usize,
    duplicate_rows: usize,
    missing_employee_rows: usize,
    ambiguous_employee_rows: usize,
    row_errors: Vec<AttendanceImportRowError>,
    #[serde(skip_serializing)]
    ready_rows_for_apply: Vec<ResolvedAttendanceImportRow>,
}

#[derive(Debug, Clone, Serialize)]
struct AttendanceImportRowError {
    source_sheet: String,
    source_row: i32,
    source_key: String,
    code: String,
    message: String,
}

#[derive(Debug, Serialize)]
struct AttendanceImportApplyReport {
    run_id: Uuid,
    inserted: usize,
    skipped: usize,
    error_rows: usize,
}

#[derive(Debug, Serialize)]
struct AttendanceImportSummaryItem {
    run_id: Uuid,
    status: String,
    source_filename: String,
    source_format: String,
    source_sha256: String,
    input_rows: i32,
    candidate_rows: i32,
    preserved_rows: i32,
    dry_run_summary: Value,
    apply_summary: Value,
    created_at: OffsetDateTime,
    #[serde(skip_serializing_if = "Option::is_none")]
    applied_at: Option<OffsetDateTime>,
}

#[derive(Debug, Serialize)]
struct AttendanceImportSummaryPage {
    items: Vec<AttendanceImportSummaryItem>,
    total: i64,
    limit: i64,
    offset: i64,
}

/// Read one multipart text part as a `YYYY-MM-DD` date.
fn parse_period_part(name: &str, raw: &str) -> Result<Date, HrError> {
    Date::parse(
        raw.trim(),
        &time::format_description::well_known::Iso8601::DATE,
    )
    .map_err(|_| HrError::validation(format!("{name} must be an ISO date (YYYY-MM-DD)")))
}

/// Collect the file part and the declared pay period from a multipart upload.
///
/// EVERY part is drained before anything is decided. The previous readers
/// `return Ok(...)` from INSIDE the `next_field()` loop the moment they had the
/// file, so any part sent AFTER `file` was silently discarded -- a period field
/// would have vanished with no error at all, and the upload would have been
/// rejected later for a reason that named the wrong thing.
async fn read_periodised_upload(
    mut multipart: Multipart,
    max_bytes: u64,
    default_filename: &str,
    accept: fn(&str) -> bool,
    accept_message: &'static str,
) -> Result<XlsxUpload, HrError> {
    let mut filename: Option<String> = None;
    let mut bytes: Option<Vec<u8>> = None;
    let mut start_raw: Option<String> = None;
    let mut end_raw: Option<String> = None;
    let mut mapping: Option<String> = None;

    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|err| HrError::validation(err.to_string()))?
    {
        match field.name() {
            Some("file") => {
                let name = field
                    .file_name()
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| default_filename.to_owned());
                if !accept(&name.to_ascii_lowercase()) {
                    return Err(HrError::validation(accept_message));
                }
                let mut buffer = Vec::new();
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|err| HrError::validation(err.to_string()))?
                {
                    if (buffer.len() + chunk.len()) as u64 > max_bytes {
                        return Err(HrError {
                            status: StatusCode::PAYLOAD_TOO_LARGE,
                            code: "import_file_too_large",
                            message: "uploaded file exceeds the maximum import size".to_owned(),
                            refusals: None,
                        });
                    }
                    buffer.extend_from_slice(&chunk);
                }
                reject_rrn_label(
                    &name,
                    "uploaded file name must not contain a resident registration number",
                )?;
                filename = Some(name);
                bytes = Some(buffer);
            }
            Some("pay_period_start") => {
                start_raw = Some(
                    field
                        .text()
                        .await
                        .map_err(|err| HrError::validation(err.to_string()))?,
                );
            }
            // IMPORT-2: the operator's sheet mapping (JSON), if any.
            Some("mapping") => {
                mapping = Some(
                    field
                        .text()
                        .await
                        .map_err(|err| HrError::validation(err.to_string()))?,
                );
            }
            Some("pay_period_end") => {
                end_raw = Some(
                    field
                        .text()
                        .await
                        .map_err(|err| HrError::validation(err.to_string()))?,
                );
            }
            _ => continue,
        }
    }

    let (Some(filename), Some(bytes)) = (filename, bytes) else {
        return Err(HrError::validation(
            "multipart upload is missing the 'file' field",
        ));
    };
    if bytes.is_empty() {
        return Err(HrError::validation("uploaded file is empty"));
    }
    // Never defaulted: both, or neither (W12: an employee roster has none; the
    // attendance reader requires both, `require_pay_period`).
    let (pay_period_start, pay_period_end) = match (start_raw, end_raw) {
        (None, None) => (None, None),
        (Some(start_raw), Some(end_raw)) => {
            let start = parse_period_part("pay_period_start", &start_raw)?;
            let end = parse_period_part("pay_period_end", &end_raw)?;
            if end < start {
                return Err(HrError::validation(
                    "pay_period_end must not precede pay_period_start",
                ));
            }
            (Some(start), Some(end))
        }
        _ => return Err(missing_pay_period()),
    };
    Ok(XlsxUpload {
        filename,
        bytes,
        mapping,
        pay_period_start,
        pay_period_end,
    })
}

fn missing_pay_period() -> HrError {
    HrError::validation("multipart upload must declare 'pay_period_start' and 'pay_period_end'")
}

/// Required, not defaulted, for an attendance upload: an import with no
/// declared period cannot be scoped to a payroll run, and guessing one is how
/// a roster ends up built from the wrong month.
fn require_pay_period(upload: XlsxUpload) -> Result<XlsxUpload, HrError> {
    match (upload.pay_period_start, upload.pay_period_end) {
        (Some(_), Some(_)) => Ok(upload),
        _ => Err(missing_pay_period()),
    }
}

async fn read_xlsx_upload(multipart: Multipart, max_bytes: u64) -> Result<XlsxUpload, HrError> {
    read_periodised_upload(
        multipart,
        max_bytes,
        "employees.xlsx",
        |lower| lower.ends_with(".xlsx"),
        "employee import currently accepts .xlsx workbooks only",
    )
    .await
}

async fn read_attendance_upload(
    multipart: Multipart,
    max_bytes: u64,
) -> Result<XlsxUpload, HrError> {
    read_periodised_upload(
        multipart,
        max_bytes,
        "attendance.csv",
        |lower| lower.ends_with(".xlsx") || lower.ends_with(".csv"),
        "attendance import accepts .xlsx workbooks or .csv files only",
    )
    .await
    .and_then(require_pay_period)
}

#[derive(Debug, Clone)]
struct ParsedAttendanceImportUpload {
    rows: Vec<ParsedAttendanceImportRow>,
}

#[derive(Debug, Clone)]
struct ParsedAttendanceImportRow {
    source_sheet: String,
    source_row: i32,
    source_key: String,
    raw_row: Value,
    /// Headers of non-empty cells kept out of `raw_row` (restricted or
    /// RRN-shaped); in memory only, for the mapping profile.
    dropped_columns: Vec<String>,
    employee_number: Option<String>,
    employee_name: Option<String>,
    branch_name: Option<String>,
    work_date: Option<String>,
    check_in_at: Option<String>,
    check_out_at: Option<String>,
    minutes_worked: Option<i32>,
    row_status: ImportRowStatus,
    validation_errors: Vec<String>,
}

impl ParsedAttendanceImportRow {
    fn duplicate_fingerprint(&self) -> Option<String> {
        Some(format!(
            "employee:{}|name:{}|branch:{}|date:{}|in:{}|out:{}|minutes:{}",
            self.employee_number
                .as_deref()
                .or(self.employee_name.as_deref())?,
            self.employee_name.as_deref().unwrap_or_default(),
            self.branch_name.as_deref()?,
            self.work_date.as_deref()?,
            self.check_in_at.as_deref().unwrap_or_default(),
            self.check_out_at.as_deref().unwrap_or_default(),
            self.minutes_worked
                .map(|value| value.to_string())
                .unwrap_or_default()
        ))
    }
}

#[derive(Debug)]
struct AttendanceImportHeader {
    zero_based_row: usize,
    normalized_headers: Vec<String>,
    columns: Vec<AttendanceImportColumn>,
}

#[derive(Debug)]
struct AttendanceImportFieldDefinition {
    target: &'static str,
    aliases: &'static [&'static str],
    required: bool,
}

const ATTENDANCE_IMPORT_FIELD_DEFINITIONS: &[AttendanceImportFieldDefinition] = &[
    AttendanceImportFieldDefinition {
        target: "employee_number",
        aliases: &[
            "사번",
            "직원번호",
            "임직원번호",
            "employee_number",
            "employeenumber",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "employee_name",
        aliases: &[
            "성명",
            "이름",
            "직원명",
            "사원명",
            "근로자명",
            "employee_name",
            "employeename",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "branch_name",
        aliases: &[
            "지점",
            "지점명",
            "근무지",
            "사업장",
            "branch",
            "branch_name",
            "branchname",
        ],
        required: true,
    },
    AttendanceImportFieldDefinition {
        target: "work_date",
        aliases: &[
            "근무일",
            "일자",
            "날짜",
            "출근일",
            "work_date",
            "workdate",
            "date",
        ],
        required: true,
    },
    AttendanceImportFieldDefinition {
        target: "check_in_at",
        aliases: &[
            "출근",
            "출근시간",
            "시작시간",
            "clock_in",
            "check_in",
            "checkin",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "check_out_at",
        aliases: &[
            "퇴근",
            "퇴근시간",
            "종료시간",
            "clock_out",
            "check_out",
            "checkout",
        ],
        required: false,
    },
    AttendanceImportFieldDefinition {
        target: "minutes_worked",
        aliases: &[
            "근무분",
            "근무시간분",
            "근무시간",
            "minutes_worked",
            "minutesworked",
            "work_minutes",
        ],
        required: false,
    },
];

fn parse_attendance_import_upload(
    filename: &str,
    bytes: &[u8],
    sheets: &[GridSheet],
) -> Result<ParsedAttendanceImportUpload, HrError> {
    let lower = filename.to_ascii_lowercase();
    let mut rows = if lower.ends_with(".csv") {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| HrError::workbook("attendance CSV must be valid UTF-8"))?;
        parse_attendance_csv(filename, text)?
    } else if lower.ends_with(".xlsx") {
        parse_attendance_xlsx(filename, sheets)?
    } else {
        return Err(HrError::validation(
            "attendance import accepts .xlsx workbooks or .csv files only",
        ));
    };

    mark_duplicate_attendance_rows(&mut rows);
    if rows.is_empty() {
        return Err(HrError::workbook(
            "attendance import did not contain any non-empty data rows",
        ));
    }
    Ok(ParsedAttendanceImportUpload { rows })
}

/// The bounded reader's sheets as dense rows of cell values (IMPORT-2 item 0:
/// the attendance upload goes through the same caps as the employee one).
fn parse_attendance_xlsx(
    filename: &str,
    sheets: &[GridSheet],
) -> Result<Vec<ParsedAttendanceImportRow>, HrError> {
    let mut rows = Vec::new();
    for sheet in sheets {
        reject_rrn_label(
            &sheet.name,
            "workbook sheet names must not contain a resident registration number",
        )?;
        let last = sheet.rows.last().map_or(0, |row| row.index as usize + 1);
        let mut values = vec![Vec::new(); last];
        for row in &sheet.rows {
            let width = row.cells.last().map_or(0, |(col, _)| *col as usize + 1);
            values[row.index as usize] = (0..width)
                .map(|col| sheet_cell_json(row.get(col as u32)))
                .collect();
        }
        rows.extend(parse_attendance_tabular_sheet(
            filename,
            &sheet.name,
            &values,
            false,
        )?);
    }
    Ok(rows)
}

fn parse_attendance_csv(
    filename: &str,
    text: &str,
) -> Result<Vec<ParsedAttendanceImportRow>, HrError> {
    let rows = parse_csv_rows(text)?
        .into_iter()
        .map(|row| row.into_iter().map(Value::String).collect::<Vec<_>>())
        .collect::<Vec<_>>();
    parse_attendance_tabular_sheet(filename, "CSV", &rows, true)
}

fn parse_attendance_tabular_sheet(
    _filename: &str,
    sheet: &str,
    rows: &[Vec<Value>],
    require_header: bool,
) -> Result<Vec<ParsedAttendanceImportRow>, HrError> {
    let Some(header) = detect_attendance_import_header(rows) else {
        return if require_header {
            Err(HrError::workbook(
                "attendance import is missing required headers",
            ))
        } else {
            Ok(Vec::new())
        };
    };

    let mut parsed = Vec::new();
    for (zero_based_idx, row) in rows
        .iter()
        .enumerate()
        .skip(header.zero_based_row.saturating_add(1))
    {
        if !row.iter().any(|cell| json_value_text(cell).is_some()) {
            continue;
        }
        let source_row = i32::try_from(zero_based_idx + 1)
            .map_err(|_| HrError::workbook("source row does not fit i32"))?;
        let (raw_row, dropped_columns) = persistable_import_row(
            &header.normalized_headers,
            |idx| row.get(idx).cloned().unwrap_or(Value::Null),
            |header| {
                attendance_import_target_for_header(header).is_none()
                    && is_restricted_attendance_import_header(header)
            },
        );
        let employee_number =
            raw_text_for_attendance_target(&raw_row, &header.columns, "employee_number");
        let employee_name =
            raw_text_for_attendance_target(&raw_row, &header.columns, "employee_name");
        let branch_name = raw_text_for_attendance_target(&raw_row, &header.columns, "branch_name");
        let work_date_raw = raw_text_for_attendance_target(&raw_row, &header.columns, "work_date");
        let (work_date, invalid_work_date) = match work_date_raw.as_deref() {
            Some(value) => match normalized_work_date(value) {
                Ok(date) => (Some(date), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };
        let check_in_raw = raw_text_for_attendance_target(&raw_row, &header.columns, "check_in_at");
        let (check_in_at, invalid_check_in_at) = match check_in_raw.as_deref() {
            Some(value) => match normalized_attendance_time(value) {
                Ok(time) => (Some(time), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };
        let check_out_raw =
            raw_text_for_attendance_target(&raw_row, &header.columns, "check_out_at");
        let (check_out_at, invalid_check_out_at) = match check_out_raw.as_deref() {
            Some(value) => match normalized_attendance_time(value) {
                Ok(time) => (Some(time), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };
        let minutes_raw =
            raw_text_for_attendance_target(&raw_row, &header.columns, "minutes_worked");
        let (minutes_worked, invalid_minutes) = match minutes_raw.as_deref() {
            Some(value) => match normalized_minutes_worked(value) {
                Ok(minutes) => (Some(minutes), false),
                Err(_) => (None, true),
            },
            None => (None, false),
        };

        let mut validation_errors = Vec::new();
        if employee_number.is_none() && employee_name.is_none() {
            validation_errors.push("missing_employee_identifier".to_owned());
        }
        if branch_name.is_none() {
            validation_errors.push("missing_branch_name".to_owned());
        }
        if work_date.is_none() {
            validation_errors.push("missing_work_date".to_owned());
        }
        if invalid_work_date {
            validation_errors.push("invalid_work_date".to_owned());
        }
        if invalid_minutes {
            validation_errors.push("invalid_minutes_worked".to_owned());
        }
        if invalid_check_in_at {
            validation_errors.push("invalid_check_in_at".to_owned());
        }
        if invalid_check_out_at {
            validation_errors.push("invalid_check_out_at".to_owned());
        }
        if check_in_at.is_none() && check_out_at.is_none() && minutes_worked.is_none() {
            validation_errors.push("missing_attendance_time".to_owned());
        }

        let row_status = if validation_errors.is_empty() {
            ImportRowStatus::Candidate
        } else {
            ImportRowStatus::Error
        };
        parsed.push(ParsedAttendanceImportRow {
            source_sheet: sheet.to_owned(),
            source_row,
            source_key: format!("sheet:{sheet}|row:{source_row}"),
            raw_row,
            dropped_columns,
            employee_number,
            employee_name,
            branch_name,
            work_date,
            check_in_at,
            check_out_at,
            minutes_worked,
            row_status,
            validation_errors,
        });
    }
    Ok(parsed)
}

fn detect_attendance_import_header(rows: &[Vec<Value>]) -> Option<AttendanceImportHeader> {
    for (zero_based_row, row) in rows.iter().enumerate().take(MAX_IMPORT_HEADER_SCAN_ROWS) {
        let normalized_headers = row
            .iter()
            .map(|cell| {
                json_value_text(cell)
                    .filter(|value| !is_rrn_value(value))
                    .map_or_else(String::new, |value| normalize_header_label(&value))
            })
            .collect::<Vec<_>>();
        let targets = normalized_headers
            .iter()
            .filter_map(|header| attendance_import_target_for_header(header))
            .collect::<BTreeSet<_>>();
        let has_employee = targets.contains("employee_number") || targets.contains("employee_name");
        let has_required = ATTENDANCE_IMPORT_FIELD_DEFINITIONS
            .iter()
            .filter(|field| field.required)
            .all(|field| targets.contains(field.target));
        if has_employee && has_required {
            let columns = normalized_headers
                .iter()
                .filter(|header| !header.is_empty())
                .map(|header| attendance_import_column(header, header))
                .collect::<Vec<_>>();
            return Some(AttendanceImportHeader {
                zero_based_row,
                normalized_headers,
                columns,
            });
        }
    }
    None
}

fn mark_duplicate_attendance_rows(rows: &mut [ParsedAttendanceImportRow]) {
    let mut counts = BTreeMap::<String, usize>::new();
    for row in rows.iter() {
        if row.row_status == ImportRowStatus::Candidate
            && let Some(key) = row.duplicate_fingerprint()
        {
            *counts.entry(key).or_default() += 1;
        }
    }
    for row in rows.iter_mut() {
        let Some(key) = row.duplicate_fingerprint() else {
            continue;
        };
        if counts.get(&key).copied().unwrap_or_default() > 1 {
            row.row_status = ImportRowStatus::Error;
            row.validation_errors
                .push("duplicate_row_in_file".to_owned());
        }
    }
}

fn parse_csv_rows(text: &str) -> Result<Vec<Vec<String>>, HrError> {
    let mut rows = Vec::new();
    let mut row = Vec::new();
    let mut field = String::new();
    let mut chars = text.chars().peekable();
    let mut in_quotes = false;

    while let Some(ch) = chars.next() {
        match ch {
            '"' if in_quotes && chars.peek() == Some(&'"') => {
                field.push('"');
                chars.next();
            }
            '"' => {
                in_quotes = !in_quotes;
            }
            ',' if !in_quotes => {
                row.push(field.trim().to_owned());
                field.clear();
            }
            '\n' if !in_quotes => {
                row.push(field.trim().to_owned());
                field.clear();
                if row.iter().any(|value| !value.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            '\r' if !in_quotes => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(field.trim().to_owned());
                field.clear();
                if row.iter().any(|value| !value.is_empty()) {
                    rows.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
            }
            _ => field.push(ch),
        }
    }

    if in_quotes {
        return Err(HrError::workbook(
            "attendance CSV has an unclosed quoted field",
        ));
    }
    row.push(field.trim().to_owned());
    if row.iter().any(|value| !value.is_empty()) {
        rows.push(row);
    }
    Ok(rows)
}

fn normalized_minutes_worked(value: &str) -> Result<i32, HrError> {
    let cleaned = value.replace(',', "").trim().to_owned();
    let minutes = cleaned
        .parse::<i32>()
        .map_err(|_| HrError::validation("minutes_worked must be a whole number"))?;
    if minutes < 0 {
        return Err(HrError::validation("minutes_worked must not be negative"));
    }
    Ok(minutes)
}

fn normalized_work_date(value: &str) -> Result<String, HrError> {
    let cleaned = value.trim().replace(['.', '/'], "-");
    let parts = cleaned.split('-').collect::<Vec<_>>();
    if parts.len() != 3 {
        return Err(HrError::validation("work_date must use YYYY-MM-DD"));
    }
    let year = parts[0]
        .parse::<u16>()
        .map_err(|_| HrError::validation("work_date year must be numeric"))?;
    let month = parts[1]
        .parse::<u8>()
        .map_err(|_| HrError::validation("work_date month must be numeric"))?;
    let day = parts[2]
        .parse::<u8>()
        .map_err(|_| HrError::validation("work_date day must be numeric"))?;
    if !(1900..=2100).contains(&year) || month == 0 || month > 12 {
        return Err(HrError::validation(
            "work_date is outside the supported date range",
        ));
    }
    let max_day = days_in_month(year, month);
    if day == 0 || day > max_day {
        return Err(HrError::validation("work_date day is invalid"));
    }
    Ok(format!("{year:04}-{month:02}-{day:02}"))
}

fn normalized_attendance_time(value: &str) -> Result<String, HrError> {
    let cleaned = value.trim();
    let parts = cleaned.split(':').collect::<Vec<_>>();
    if parts.len() != 2 {
        return Err(HrError::validation("attendance time must use HH:MM"));
    }
    let hour = parts[0]
        .parse::<u8>()
        .map_err(|_| HrError::validation("attendance time hour must be numeric"))?;
    let minute = parts[1]
        .parse::<u8>()
        .map_err(|_| HrError::validation("attendance time minute must be numeric"))?;
    if hour > 23 || minute > 59 {
        return Err(HrError::validation(
            "attendance time is outside the supported range",
        ));
    }
    Ok(format!("{hour:02}:{minute:02}"))
}

fn days_in_month(year: u16, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn is_leap_year(year: u16) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn attendance_source_format(filename: &str) -> Result<&'static str, HrError> {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".xlsx") {
        Ok("xlsx")
    } else if lower.ends_with(".csv") {
        Ok("csv")
    } else {
        Err(HrError::validation(
            "attendance import accepts .xlsx workbooks or .csv files only",
        ))
    }
}

fn attendance_import_target_for_header(header: &str) -> Option<&'static str> {
    let key = import_header_match_key(header);
    ATTENDANCE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .find(|field| {
            field
                .aliases
                .iter()
                .any(|alias| import_header_match_key(alias) == key)
        })
        .map(|field| field.target)
}

fn attendance_import_column(
    source_header: &str,
    normalized_header: &str,
) -> AttendanceImportColumn {
    let target = attendance_import_target_for_header(normalized_header).map(ToOwned::to_owned);
    let classification = if target.is_some() {
        "canonical"
    } else if is_restricted_attendance_import_header(normalized_header) {
        "restricted"
    } else {
        "retained"
    };
    AttendanceImportColumn {
        source_header: source_header.trim().to_owned(),
        normalized_header: normalized_header.to_owned(),
        target,
        classification: classification.to_owned(),
        preview_allowed: classification == "canonical",
    }
}

fn is_restricted_attendance_import_header(header: &str) -> bool {
    let restricted_fragments = [
        "주민",
        "급여",
        "시급",
        "수당",
        "보험",
        "소득세",
        "은행",
        "계좌",
        "전화",
        "연락처",
        "휴대폰",
        "핸드폰",
        "주소",
        "개인",
    ];
    restricted_fragments
        .iter()
        .any(|fragment| header.contains(fragment))
        || import_pii::is_pii2_restricted_header(header)
}

fn attendance_import_columns_from_rows(
    rows: &[ParsedAttendanceImportRow],
) -> Vec<AttendanceImportColumn> {
    let mut columns = BTreeMap::<String, AttendanceImportColumn>::new();
    for row in rows {
        let kept = row.raw_row.as_object().into_iter().flat_map(Map::keys);
        for key in kept.chain(&row.dropped_columns) {
            columns
                .entry(key.clone())
                .or_insert_with(|| attendance_import_column(key, key));
        }
    }
    columns.into_values().collect()
}

fn attendance_import_mapping_profile(columns: &[AttendanceImportColumn]) -> Value {
    let target_allowlist = ATTENDANCE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| field.target)
        .collect::<Vec<_>>();
    let target_catalog = ATTENDANCE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .map(|field| {
            json!({
                "target": field.target,
                "aliases": field.aliases,
                "required": field.required
            })
        })
        .collect::<Vec<_>>();
    json!({
        "entity_type": "attendance_direct",
        "target_allowlist": target_allowlist,
        "target_catalog": target_catalog,
        "columns": columns,
        "policy": {
            "unknown_columns": "retain_raw_only",
            "restricted_columns": "drop_header_only",
            "resident_registration_number_values": "drop_any_column",
            "header_detection": {
                "strategy": "attendance_schema_catalog_first_required_row",
                "scan_rows": MAX_IMPORT_HEADER_SCAN_ROWS
            },
            "employee_resolution": ["employee_number_unique", "employee_name_unique_or_ambiguous_row_error"],
            "server_side_entity_allowlist": ["attendance_direct"],
            "payroll_effect": "lineage_only_not_payable"
        }
    })
}

fn attendance_preview_values(
    raw_row: &Value,
    columns: &[AttendanceImportColumn],
) -> BTreeMap<String, Value> {
    let Some(object) = raw_row.as_object() else {
        return BTreeMap::new();
    };
    columns
        .iter()
        .filter_map(|column| {
            let value = object.get(&column.normalized_header)?;
            let masked = if column.preview_allowed {
                safe_preview_value(value)
            } else if value.is_null() {
                Value::Null
            } else {
                json!("••••")
            };
            Some((column.normalized_header.clone(), masked))
        })
        .collect()
}

fn raw_text_for_attendance_target(
    raw_row: &Value,
    columns: &[AttendanceImportColumn],
    target: &str,
) -> Option<String> {
    let object = raw_row.as_object()?;
    columns
        .iter()
        .filter(|column| column.target.as_deref() == Some(target))
        .find_map(|column| {
            let value = object.get(&column.normalized_header)?;
            json_value_text(value)
        })
}

fn attendance_canonical_row_json(row: &ParsedAttendanceImportRow, source_sha256: &str) -> Value {
    json!({
        "source_sheet": &row.source_sheet,
        "source_row": row.source_row,
        "source_key": &row.source_key,
        "source_sha256": source_sha256,
        "canonical": {
            "employee_number": &row.employee_number,
            "employee_name": &row.employee_name,
            "branch_name": &row.branch_name,
            "work_date": &row.work_date,
            "check_in_at": &row.check_in_at,
            "check_out_at": &row.check_out_at,
            "minutes_worked": row.minutes_worked
        }
    })
}

fn attendance_validation_json(row: &ParsedAttendanceImportRow) -> Value {
    match row.row_status {
        ImportRowStatus::Candidate => json!({ "status": "ok", "errors": [], "warnings": [] }),
        ImportRowStatus::Preserved => json!({
            "status": "preserved",
            "errors": [],
            "warnings": ["row_preserved_raw_only"]
        }),
        ImportRowStatus::Error => json!({
            "status": "error",
            "errors": &row.validation_errors,
            "warnings": []
        }),
    }
}

fn require_leave_import_command_store(state: &HrState) -> Result<PgLeaveStore, HrError> {
    state.leave_command_store.clone().ok_or_else(|| {
        HrError::unavailable(
            "leave command database is not configured; employee balance import is unavailable",
        )
    })
}

/// §16 ingest-commit gate (85 판정): apply ("적재") requires self-checklist
/// evidence — fail-closed deny, nothing written, if it's missing or false.
/// Authority is already enforced by the caller's `authorize_hr_org_wide` check;
/// four-eyes/egress are not part of this gate (ingest commit is single-actor).
/// reuse the legacy authz check already in front of every apply
/// handler instead of re-deriving Authority through Cedar for this lane.
fn evaluate_ingest_checklist_gate(
    checklist_all_acknowledged: Option<bool>,
) -> Result<Value, HrError> {
    let outcome = evaluate_gate_chain(
        GateChainConfig {
            self_checklist: true,
            ..GateChainConfig::default()
        },
        &GateEvidence {
            checklist_all_acknowledged,
            ..GateEvidence::default()
        },
    );
    if !outcome.allow {
        return Err(HrError::from_kernel(KernelError::forbidden(
            "ingest commit requires acknowledging the self-checklist before applying",
        )));
    }
    Ok(json!(outcome))
}

#[derive(Debug, Clone, Deserialize)]
struct AttendanceCanonicalFields {
    employee_number: Option<String>,
    employee_name: Option<String>,
    branch_name: Option<String>,
    work_date: Option<String>,
    check_in_at: Option<String>,
    check_out_at: Option<String>,
    minutes_worked: Option<i32>,
}

#[derive(Debug)]
struct StoredAttendanceImportRow {
    import_row_id: Uuid,
    source_sheet: String,
    source_row: i32,
    source_key: String,
    row_status: ImportRowStatus,
    canonical: AttendanceCanonicalFields,
    validation_errors: Vec<String>,
}

#[derive(Debug, Clone)]
struct ResolvedAttendanceImportRow {
    import_row_id: Uuid,
    employee_id: Uuid,
    branch_id: Uuid,
    source_sheet: String,
    source_row: i32,
    source_key: String,
    employee_number: Option<String>,
    employee_name: String,
    branch_name: String,
    work_date: String,
    check_in_at: Option<String>,
    check_out_at: Option<String>,
    minutes_worked: Option<i32>,
    fact_key: String,
}

struct AttendanceEmployeeResolution {
    id: Uuid,
    name: String,
    employee_number: Option<String>,
}

enum AttendanceEmployeeLookup {
    Matched(AttendanceEmployeeResolution),
    Missing,
    Ambiguous,
}

struct AttendanceBranchResolution {
    id: Uuid,
    name: String,
}

enum AttendanceBranchLookup {
    Matched(AttendanceBranchResolution),
    Missing,
    Ambiguous,
}

async fn load_attendance_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
) -> Result<Vec<StoredAttendanceImportRow>, HrError> {
    sqlx::query(
        r#"
        SELECT id, source_sheet, source_row, source_key, row_status, canonical_row, validation
        FROM data_import_rows
        WHERE org_id = $1 AND run_id = $2
        ORDER BY source_sheet ASC, source_row ASC
        "#,
    )
    .bind(org_uuid)
    .bind(run_id)
    .fetch_all(tx.as_mut())
    .await?
    .into_iter()
    .map(stored_attendance_import_row)
    .collect()
}

fn stored_attendance_import_row(
    row: sqlx::postgres::PgRow,
) -> Result<StoredAttendanceImportRow, HrError> {
    let canonical_row: Value = row.try_get("canonical_row")?;
    let validation: Value = row.try_get("validation")?;
    let canonical = serde_json::from_value::<AttendanceCanonicalFields>(
        canonical_row
            .get("canonical")
            .cloned()
            .unwrap_or_else(|| json!({})),
    )
    .map_err(|err| {
        HrError::validation(format!(
            "stored attendance import canonical row is invalid: {err}"
        ))
    })?;
    let row_status_raw: String = row.try_get("row_status")?;
    let validation_errors = validation
        .get("errors")
        .and_then(Value::as_array)
        .map(|errors| {
            errors
                .iter()
                .filter_map(Value::as_str)
                .map(ToOwned::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Ok(StoredAttendanceImportRow {
        import_row_id: row.try_get("id")?,
        source_sheet: row.try_get("source_sheet")?,
        source_row: row.try_get("source_row")?,
        source_key: row.try_get("source_key")?,
        row_status: ImportRowStatus::from_db(&row_status_raw)?,
        canonical,
        validation_errors,
    })
}

fn ensure_attendance_import_run(
    run: &DataImportRunRecord,
    allowed_statuses: &[&str],
) -> Result<(), HrError> {
    if run.entity_type != "attendance_direct" {
        return Err(HrError::from_kernel(KernelError::conflict(
            "import run is not an attendance_direct run",
        )));
    }
    if !allowed_statuses.iter().any(|status| *status == run.status) {
        return Err(HrError::from_kernel(KernelError::conflict(format!(
            "attendance import run status {} is not allowed for this transition",
            run.status
        ))));
    }
    Ok(())
}

async fn resolve_attendance_import_rows(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    run_id: Uuid,
    run: &DataImportRunRecord,
    rows: &[StoredAttendanceImportRow],
) -> Result<AttendanceImportDryRunSummary, HrError> {
    let source_keys = rows
        .iter()
        .map(|row| row.source_key.clone())
        .collect::<Vec<_>>();
    let existing_keys = if source_keys.is_empty() {
        BTreeSet::new()
    } else {
        sqlx::query_scalar::<_, String>(
            r#"
            SELECT source_key
            FROM attendance_direct_import_events
            WHERE org_id = $1 AND source_sha256 = $2 AND source_key = ANY($3)
            "#,
        )
        .bind(org_uuid)
        .bind(&run.source_sha256)
        .bind(&source_keys)
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .collect::<BTreeSet<_>>()
    };

    let mut summary = AttendanceImportDryRunSummary {
        run_id,
        input_rows: usize::try_from(run.input_rows).unwrap_or_default(),
        candidate_rows: usize::try_from(run.candidate_rows).unwrap_or_default(),
        preserved_rows: usize::try_from(run.preserved_rows).unwrap_or_default(),
        ..AttendanceImportDryRunSummary::default()
    };

    let mut resolved_fact_keys = BTreeSet::<String>::new();

    for row in rows {
        if row.row_status != ImportRowStatus::Candidate {
            summary.error_rows += 1;
            if row.validation_errors.is_empty() {
                summary.row_errors.push(attendance_row_error(
                    row,
                    "invalid_row",
                    "attendance import row is not a candidate",
                ));
            } else {
                for code in &row.validation_errors {
                    summary
                        .row_errors
                        .push(attendance_row_error(row, code, code));
                }
            }
            continue;
        }

        if existing_keys.contains(&row.source_key) {
            summary.error_rows += 1;
            summary.duplicate_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "duplicate_import_row",
                "attendance import row source key was already applied",
            ));
            continue;
        }

        let employee = match resolve_attendance_employee(tx, org_uuid, row).await? {
            AttendanceEmployeeLookup::Matched(employee) => employee,
            AttendanceEmployeeLookup::Missing => {
                summary.error_rows += 1;
                summary.missing_employee_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "missing_employee",
                    "no employee matched the attendance row identifier",
                ));
                continue;
            }
            AttendanceEmployeeLookup::Ambiguous => {
                summary.error_rows += 1;
                summary.ambiguous_employee_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "ambiguous_employee",
                    "attendance row identifier matched multiple employees",
                ));
                continue;
            }
        };
        let branch = match resolve_attendance_branch(tx, org_uuid, row).await? {
            AttendanceBranchLookup::Matched(branch) => branch,
            AttendanceBranchLookup::Missing => {
                summary.error_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "missing_branch",
                    "no branch matched the attendance row branch name",
                ));
                continue;
            }
            AttendanceBranchLookup::Ambiguous => {
                summary.error_rows += 1;
                summary.row_errors.push(attendance_row_error(
                    row,
                    "ambiguous_branch",
                    "attendance row branch name matched multiple branches",
                ));
                continue;
            }
        };

        let employee_number = row
            .canonical
            .employee_number
            .clone()
            .or(employee.employee_number.clone());
        let Some(work_date) = row.canonical.work_date.clone() else {
            summary.error_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "missing_work_date",
                "work_date is required",
            ));
            continue;
        };

        let fact_key = attendance_fact_key(
            employee.id,
            branch.id,
            &work_date,
            row.canonical.check_in_at.as_deref(),
            row.canonical.check_out_at.as_deref(),
            row.canonical.minutes_worked,
        );
        if !resolved_fact_keys.insert(fact_key.clone()) {
            summary.error_rows += 1;
            summary.duplicate_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "duplicate_attendance_fact_in_file",
                "attendance fact is duplicated within this import run",
            ));
            continue;
        }
        if attendance_fact_exists(tx, org_uuid, &fact_key).await? {
            summary.error_rows += 1;
            summary.duplicate_rows += 1;
            summary.row_errors.push(attendance_row_error(
                row,
                "duplicate_attendance_fact",
                "attendance fact was already imported",
            ));
            continue;
        }

        summary
            .ready_rows_for_apply
            .push(ResolvedAttendanceImportRow {
                import_row_id: row.import_row_id,
                employee_id: employee.id,
                branch_id: branch.id,
                source_sheet: row.source_sheet.clone(),
                source_row: row.source_row,
                source_key: row.source_key.clone(),
                employee_number,
                employee_name: employee.name,
                branch_name: branch.name,
                work_date,
                check_in_at: row.canonical.check_in_at.clone(),
                check_out_at: row.canonical.check_out_at.clone(),
                minutes_worked: row.canonical.minutes_worked,
                fact_key,
            });
    }

    summary.ready_rows = summary.ready_rows_for_apply.len();
    Ok(summary)
}

async fn resolve_attendance_employee(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    row: &StoredAttendanceImportRow,
) -> Result<AttendanceEmployeeLookup, HrError> {
    let records = if let Some(employee_number) = row.canonical.employee_number.as_deref() {
        sqlx::query(
            r#"
            SELECT id, name, employee_number
            FROM employees
            WHERE org_id = $1 AND employee_number = $2
            ORDER BY id
            LIMIT 2
            "#,
        )
        .bind(org_uuid)
        .bind(employee_number)
        .fetch_all(tx.as_mut())
        .await?
    } else if let Some(employee_name) = row.canonical.employee_name.as_deref() {
        sqlx::query(
            r#"
            SELECT id, name, employee_number
            FROM employees
            WHERE org_id = $1 AND name = $2
            ORDER BY id
            LIMIT 2
            "#,
        )
        .bind(org_uuid)
        .bind(employee_name)
        .fetch_all(tx.as_mut())
        .await?
    } else {
        return Ok(AttendanceEmployeeLookup::Missing);
    };

    if records.is_empty() {
        return Ok(AttendanceEmployeeLookup::Missing);
    }
    if records.len() > 1 {
        return Ok(AttendanceEmployeeLookup::Ambiguous);
    }
    let Some(row) = records.into_iter().next() else {
        return Ok(AttendanceEmployeeLookup::Missing);
    };
    Ok(AttendanceEmployeeLookup::Matched(
        AttendanceEmployeeResolution {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            employee_number: row.try_get("employee_number")?,
        },
    ))
}

async fn resolve_attendance_branch(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    row: &StoredAttendanceImportRow,
) -> Result<AttendanceBranchLookup, HrError> {
    let Some(branch_name) = row.canonical.branch_name.as_deref() else {
        return Ok(AttendanceBranchLookup::Missing);
    };
    let records = sqlx::query(
        r#"
        SELECT id, name
        FROM branches
        WHERE org_id = $1 AND name = $2
        ORDER BY id
        LIMIT 2
        "#,
    )
    .bind(org_uuid)
    .bind(branch_name)
    .fetch_all(tx.as_mut())
    .await?;

    if records.is_empty() {
        return Ok(AttendanceBranchLookup::Missing);
    }
    if records.len() > 1 {
        return Ok(AttendanceBranchLookup::Ambiguous);
    }
    let Some(row) = records.into_iter().next() else {
        return Ok(AttendanceBranchLookup::Missing);
    };
    Ok(AttendanceBranchLookup::Matched(
        AttendanceBranchResolution {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
        },
    ))
}

async fn attendance_fact_exists(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    fact_key: &str,
) -> Result<bool, HrError> {
    let exists: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS (
            SELECT 1
            FROM attendance_direct_import_events
            WHERE org_id = $1 AND fact_key = $2
        )
        "#,
    )
    .bind(org_uuid)
    .bind(fact_key)
    .fetch_one(tx.as_mut())
    .await?;
    Ok(exists)
}

fn attendance_fact_key(
    employee_id: Uuid,
    branch_id: Uuid,
    work_date: &str,
    check_in_at: Option<&str>,
    check_out_at: Option<&str>,
    minutes_worked: Option<i32>,
) -> String {
    format!(
        "employee:{employee_id}|branch:{branch_id}|date:{work_date}|in:{}|out:{}|minutes:{}",
        check_in_at.unwrap_or_default(),
        check_out_at.unwrap_or_default(),
        minutes_worked
            .map(|value| value.to_string())
            .unwrap_or_default()
    )
}

fn attendance_row_error(
    row: &StoredAttendanceImportRow,
    code: impl Into<String>,
    message: impl Into<String>,
) -> AttendanceImportRowError {
    AttendanceImportRowError {
        source_sheet: row.source_sheet.clone(),
        source_row: row.source_row,
        source_key: row.source_key.clone(),
        code: code.into(),
        message: message.into(),
    }
}

/// Materialize absence alerts from imported attendance facts, returning the ids
/// of the rows this pass actually INSERTed or UPDATEd. On unchanged imports the
/// `IS DISTINCT FROM` guard on the ON CONFLICT UPDATE (plus DO NOTHING on true
/// duplicates) means `RETURNING` yields nothing — so a repeated dashboard read
/// reports zero changed rows and emits no audit event (0093 review MEDIUM #5:
/// the caller audits only real mutations, preserving the write-storm guard).
async fn materialize_absence_alerts_from_imports(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org_uuid: Uuid,
    scope: &BranchScope,
) -> Result<Vec<Uuid>, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        INSERT INTO employee_absence_alerts (
            org_id, employee_id, branch_id, work_date, source, severity, signal_payload
        )
        SELECT DISTINCT ON (a.employee_id, a.work_date::DATE)
            a.org_id,
            a.employee_id,
            a.branch_id,
            a.work_date::DATE,
            'attendance_direct_import',
            'WARNING',
            jsonb_build_object(
                'signal', 'NO_CLOCK_OR_ZERO_MINUTES',
                'source_sheet', a.source_sheet,
                'source_row', a.source_row,
                'source_key', a.source_key,
                'employee_name', a.employee_name,
                'branch_name', a.branch_name,
                'work_date', a.work_date,
                'message', 'Imported attendance row has no clock-in/out and zero worked minutes.'
            )
        FROM attendance_direct_import_events a
        JOIN employees e
          ON e.id = a.employee_id
         AND e.org_id = a.org_id
        WHERE a.org_id =
        "#,
    );
    builder.push_bind(org_uuid);
    builder.push(
        r#"
          AND e.employment_status = 'ACTIVE'
          AND a.check_in_at IS NULL
          AND a.check_out_at IS NULL
          AND COALESCE(a.minutes_worked, 0) = 0
          AND
        "#,
    );
    push_branch_scope_column(&mut builder, scope, "a.branch_id");
    builder.push(
        r#"
        ORDER BY a.employee_id, a.work_date::DATE, a.created_at DESC, a.id DESC
        ON CONFLICT (org_id, employee_id, work_date, source)
        DO UPDATE SET
            branch_id = EXCLUDED.branch_id,
            severity = EXCLUDED.severity,
            signal_payload = EXCLUDED.signal_payload,
            updated_at = now()
        WHERE employee_absence_alerts.status = 'OPEN'
          -- Write-storm bound (S6.3): this materializer runs on the dashboard GET
          -- path, so an unconditional DO UPDATE would rewrite every OPEN alert on
          -- every read (dead tuples + WAL per request). The IS DISTINCT FROM guard
          -- makes a repeated read over unchanged imports touch ZERO rows, so the
          -- per-request write set is bounded to alerts whose import facts actually
          -- changed, while still refreshing an alert when a re-import corrects it.
          AND (
            employee_absence_alerts.branch_id IS DISTINCT FROM EXCLUDED.branch_id
            OR employee_absence_alerts.severity IS DISTINCT FROM EXCLUDED.severity
            OR employee_absence_alerts.signal_payload IS DISTINCT FROM EXCLUDED.signal_payload
          )
        RETURNING id
        "#,
    );
    let changed_ids: Vec<Uuid> = builder.build_query_scalar().fetch_all(tx.as_mut()).await?;
    Ok(changed_ids)
}

async fn load_absence_exit_summary(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &BranchScope,
) -> Result<AbsenceExitSummary, HrError> {
    Ok(AbsenceExitSummary {
        open_absence_alerts: count_absence_alerts(tx, scope, "a.status = 'OPEN'").await?,
        exit_cases_pending_hr: count_exit_cases(tx, scope, "c.status = 'REPORTED'").await?,
        settlement_needs_source: count_exit_packages(tx, scope, "p.status = 'NEEDS_SOURCE'")
            .await?,
        settlement_ready: count_exit_packages(tx, scope, "p.status = 'READY_FOR_APPROVAL'").await?,
        approval_drafts: count_exit_packages(tx, scope, "p.status = 'APPROVAL_DRAFTED'").await?,
        submitted: count_exit_cases(tx, scope, "c.status = 'SUBMITTED'").await?,
    })
}

async fn count_absence_alerts(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &BranchScope,
    predicate: &'static str,
) -> Result<i64, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*)::BIGINT FROM employee_absence_alerts a WHERE ",
    );
    builder.push(predicate);
    builder.push(" AND ");
    push_branch_scope_column(&mut builder, scope, "a.branch_id");
    Ok(builder.build_query_scalar().fetch_one(tx.as_mut()).await?)
}

async fn count_exit_cases(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &BranchScope,
    predicate: &'static str,
) -> Result<i64, HrError> {
    let mut builder =
        QueryBuilder::<Postgres>::new("SELECT COUNT(*)::BIGINT FROM employee_exit_cases c WHERE ");
    builder.push(predicate);
    builder.push(" AND ");
    push_branch_scope_column(&mut builder, scope, "c.branch_id");
    Ok(builder.build_query_scalar().fetch_one(tx.as_mut()).await?)
}

async fn count_exit_packages(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &BranchScope,
    predicate: &'static str,
) -> Result<i64, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT COUNT(*)::BIGINT
        FROM employee_exit_settlement_packages p
        JOIN employee_exit_cases c
          ON c.id = p.exit_case_id
         AND c.org_id = p.org_id
        WHERE c.status NOT IN ('REJECTED', 'CANCELLED') AND
        "#,
    );
    builder.push(predicate);
    builder.push(" AND ");
    push_branch_scope_column(&mut builder, scope, "c.branch_id");
    Ok(builder.build_query_scalar().fetch_one(tx.as_mut()).await?)
}

async fn load_absence_alerts(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    scope: &BranchScope,
    employee_id: Option<Uuid>,
    limit: i64,
    offset: i64,
) -> Result<Vec<EmployeeAbsenceAlertResponse>, HrError> {
    let mut builder = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            a.id,
            a.employee_id,
            e.name AS employee_name,
            e.employee_number,
            e.company,
            e.org_unit,
            e.worksite_name,
            a.branch_id,
            b.name AS branch_name,
            a.work_date::TEXT AS work_date,
            a.source,
            a.status,
            a.severity,
            a.audience_roles,
            a.signal_payload,
            a.linked_exit_case_id AS exit_case_id,
            a.detected_at
        FROM employee_absence_alerts a
        JOIN employees e
          ON e.id = a.employee_id
         AND e.org_id = a.org_id
        LEFT JOIN branches b
          ON b.id = a.branch_id
         AND b.org_id = a.org_id
        WHERE
        "#,
    );
    push_branch_scope_column(&mut builder, scope, "a.branch_id");
    if let Some(employee_id) = employee_id {
        builder.push(" AND a.employee_id = ");
        builder.push_bind(employee_id);
    }
    builder.push(" ORDER BY a.work_date DESC, a.detected_at DESC, a.id DESC LIMIT ");
    builder.push_bind(limit);
    builder.push(" OFFSET ");
    builder.push_bind(offset);

    builder
        .build()
        .fetch_all(tx.as_mut())
        .await?
        .into_iter()
        .map(absence_alert_from_row)
        .collect::<Result<Vec<_>, HrError>>()
}

fn absence_alert_from_row(
    row: sqlx::postgres::PgRow,
) -> Result<EmployeeAbsenceAlertResponse, HrError> {
    let id: Uuid = row.try_get("id")?;
    let employee_id: Uuid = row.try_get("employee_id")?;
    let employee_name: String = row.try_get("employee_name")?;
    let work_date: String = row.try_get("work_date")?;
    let branch_name: Option<String> = row.try_get("branch_name")?;
    let audience_roles: Vec<String> = row.try_get("audience_roles")?;
    let notification_title = format!("결근 이상징후: {employee_name}");
    let notification_message = match branch_name.as_deref() {
        Some(branch) => {
            format!("{work_date} {branch} 근태자료에서 출퇴근 기록이 확인되지 않았습니다.")
        }
        None => format!("{work_date} 근태자료에서 출퇴근 기록이 확인되지 않았습니다."),
    };
    Ok(EmployeeAbsenceAlertResponse {
        id,
        employee_id,
        employee_name,
        employee_number: row.try_get("employee_number")?,
        company: row.try_get("company")?,
        org_unit: row.try_get("org_unit")?,
        worksite_name: row.try_get("worksite_name")?,
        branch_id: row.try_get("branch_id")?,
        branch_name,
        work_date,
        source: row.try_get("source")?,
        status: row.try_get("status")?,
        severity: row.try_get("severity")?,
        audience_roles,
        signal_payload: row.try_get("signal_payload")?,
        notification_title,
        notification_message,
        link_href: format!("/insurance-assist?employee={employee_id}&alert={id}"),
        exit_case_id: row.try_get("exit_case_id")?,
        detected_at: row.try_get("detected_at")?,
    })
}

async fn load_linked_employee_for_user(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    user_id: UserId,
    lock_user: bool,
) -> Result<LinkedEmployee, HrError> {
    let sql = if lock_user {
        r#"
        SELECT u.employee_id, e.name AS employee_name
        FROM users u
        LEFT JOIN employees e
          ON e.id = u.employee_id
         AND e.org_id = u.org_id
        WHERE u.id = $1
          AND u.org_id = $2
        FOR UPDATE OF u
        "#
    } else {
        r#"
        SELECT u.employee_id, e.name AS employee_name
        FROM users u
        LEFT JOIN employees e
          ON e.id = u.employee_id
         AND e.org_id = u.org_id
        WHERE u.id = $1
          AND u.org_id = $2
        "#
    };

    let row = sqlx::query(sql)
        .bind(*user_id.as_uuid())
        .bind(*org.as_uuid())
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee account required"))
        })?;

    let employee_id = row
        .try_get::<Option<Uuid>, _>("employee_id")?
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee account required"))
        })?;
    let display_name = row
        .try_get::<Option<String>, _>("employee_name")?
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            HrError::from_kernel(KernelError::forbidden("linked employee record required"))
        })?;

    Ok(LinkedEmployee {
        employee_id,
        display_name,
    })
}

/// Employee id linked to `user_id`, or `None` when the account has no employee
/// link. Self-service *reads* use this so an unlinked user (an ADMIN/system
/// account) sees an empty page instead of the 403 `load_linked_employee_for_user`
/// raises for the write path.
async fn load_optional_linked_employee_id(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    org: OrgId,
    user_id: UserId,
) -> Result<Option<Uuid>, HrError> {
    let employee_id: Option<Uuid> =
        sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1 AND org_id = $2")
            .bind(*user_id.as_uuid())
            .bind(*org.as_uuid())
            .fetch_optional(tx.as_mut())
            .await?
            .flatten();
    Ok(employee_id)
}

async fn list_attendance_records_for_employee(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    employee_id: Uuid,
    branch_id: Option<Uuid>,
    limit: i64,
    offset: i64,
) -> Result<EmployeeAttendanceRecordPage, HrError> {
    let mut total_query = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*)::BIGINT FROM employee_attendance_records r JOIN employees e ON e.id = r.employee_id AND e.org_id = r.org_id WHERE r.employee_id = ",
    );
    total_query.push_bind(employee_id);
    if let Some(branch_id) = branch_id {
        total_query.push(" AND e.home_branch_id = ");
        total_query.push_bind(branch_id);
    }
    let total: i64 = total_query
        .build_query_scalar()
        .fetch_one(tx.as_mut())
        .await?;

    let mut rows_query = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            r.id,
            r.employee_id,
            e.name AS employee_display_name,
            r.kind,
            r.occurred_at,
            r.work_date::TEXT AS work_date,
            r.state_after,
            r.note,
            pmr.id AS payroll_material_ref_id
        FROM employee_attendance_records r
        JOIN employees e
          ON e.id = r.employee_id
         AND e.org_id = r.org_id
        JOIN payroll_attendance_material_refs pmr
          ON pmr.attendance_record_id = r.id
         AND pmr.org_id = r.org_id
        WHERE r.employee_id =
        "#,
    );
    rows_query.push_bind(employee_id);
    if let Some(branch_id) = branch_id {
        rows_query.push(" AND e.home_branch_id = ");
        rows_query.push_bind(branch_id);
    }
    rows_query.push(" ORDER BY r.occurred_at DESC, r.created_at DESC, r.id DESC LIMIT ");
    rows_query.push_bind(limit);
    rows_query.push(" OFFSET ");
    rows_query.push_bind(offset);
    let rows = rows_query.build().fetch_all(tx.as_mut()).await?;

    let items = rows
        .into_iter()
        .map(|row| employee_attendance_record_from_joined_row(row, false))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(EmployeeAttendanceRecordPage {
        items,
        total,
        limit,
        offset,
    })
}

async fn list_attendance_records_for_org(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    branch_id: Option<Uuid>,
    limit: i64,
    offset: i64,
) -> Result<EmployeeAttendanceRecordPage, HrError> {
    let mut total_query = QueryBuilder::<Postgres>::new(
        "SELECT COUNT(*)::BIGINT FROM employee_attendance_records r JOIN employees e ON e.id = r.employee_id AND e.org_id = r.org_id WHERE TRUE",
    );
    if let Some(branch_id) = branch_id {
        total_query.push(" AND e.home_branch_id = ");
        total_query.push_bind(branch_id);
    }
    let total: i64 = total_query
        .build_query_scalar()
        .fetch_one(tx.as_mut())
        .await?;

    let mut rows_query = QueryBuilder::<Postgres>::new(
        r#"
        SELECT
            r.id,
            r.employee_id,
            e.name AS employee_display_name,
            r.kind,
            r.occurred_at,
            r.work_date::TEXT AS work_date,
            r.state_after,
            r.note,
            pmr.id AS payroll_material_ref_id
        FROM employee_attendance_records r
        JOIN employees e
          ON e.id = r.employee_id
         AND e.org_id = r.org_id
        JOIN payroll_attendance_material_refs pmr
          ON pmr.attendance_record_id = r.id
         AND pmr.org_id = r.org_id
        WHERE TRUE
        "#,
    );
    if let Some(branch_id) = branch_id {
        rows_query.push(" AND e.home_branch_id = ");
        rows_query.push_bind(branch_id);
    }
    rows_query.push(" ORDER BY r.occurred_at DESC, r.created_at DESC, r.id DESC LIMIT ");
    rows_query.push_bind(limit);
    rows_query.push(" OFFSET ");
    rows_query.push_bind(offset);
    let rows = rows_query.build().fetch_all(tx.as_mut()).await?;

    let items = rows
        .into_iter()
        .map(|row| employee_attendance_record_from_joined_row(row, false))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(EmployeeAttendanceRecordPage {
        items,
        total,
        limit,
        offset,
    })
}

async fn load_attendance_record_by_idempotency_key(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    employee_id: Uuid,
    idempotency_key: &str,
) -> Result<Option<EmployeeAttendanceRecordResponse>, HrError> {
    let row = sqlx::query(
        r#"
        SELECT
            r.id,
            r.employee_id,
            e.name AS employee_display_name,
            r.kind,
            r.occurred_at,
            r.work_date::TEXT AS work_date,
            r.state_after,
            r.note,
            pmr.id AS payroll_material_ref_id
        FROM employee_attendance_records r
        JOIN employees e
          ON e.id = r.employee_id
         AND e.org_id = r.org_id
        JOIN payroll_attendance_material_refs pmr
          ON pmr.attendance_record_id = r.id
         AND pmr.org_id = r.org_id
        WHERE r.employee_id = $1
          AND r.idempotency_key = $2
        "#,
    )
    .bind(employee_id)
    .bind(idempotency_key)
    .fetch_optional(tx.as_mut())
    .await?;

    row.map(|row| employee_attendance_record_from_joined_row(row, true))
        .transpose()
}

fn employee_attendance_record_from_joined_row(
    row: sqlx::postgres::PgRow,
    duplicate: bool,
) -> Result<EmployeeAttendanceRecordResponse, HrError> {
    Ok(EmployeeAttendanceRecordResponse {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        employee_display_name: row.try_get("employee_display_name")?,
        kind: row.try_get("kind")?,
        occurred_at: row.try_get("occurred_at")?,
        work_date: row.try_get("work_date")?,
        state_after: row.try_get("state_after")?,
        note: row.try_get("note")?,
        payroll_material_ref_id: row.try_get("payroll_material_ref_id")?,
        payroll_link_status: "LINKED".to_owned(),
        duplicate,
    })
}

fn employee_attendance_record_from_parts(
    row: sqlx::postgres::PgRow,
    employee_display_name: String,
    payroll_material_ref_id: Uuid,
    duplicate: bool,
) -> Result<EmployeeAttendanceRecordResponse, HrError> {
    Ok(EmployeeAttendanceRecordResponse {
        id: row.try_get("id")?,
        employee_id: row.try_get("employee_id")?,
        employee_display_name,
        kind: row.try_get("kind")?,
        occurred_at: row.try_get("occurred_at")?,
        work_date: row.try_get("work_date")?,
        state_after: row.try_get("state_after")?,
        note: row.try_get("note")?,
        payroll_material_ref_id,
        payroll_link_status: "LINKED".to_owned(),
        duplicate,
    })
}

fn push_attendance_branch_scope(builder: &mut QueryBuilder<Postgres>, scope: &BranchScope) {
    match scope {
        BranchScope::All => {
            builder.push(" TRUE ");
        }
        BranchScope::Branches(branches) if branches.is_empty() => {
            builder.push(" FALSE ");
        }
        BranchScope::Branches(branches) => {
            let ids = branches
                .iter()
                .map(|branch| *branch.as_uuid())
                .collect::<Vec<_>>();
            builder.push(" l.branch_id = ANY(");
            builder.push_bind(ids);
            builder.push(") ");
        }
    };
}

/// Manager attendance endpoints either receive a concrete authorized branch or
/// passed the explicit organization-wide gate. Do not derive a filter from the
/// caller's ambient scope here: branch omission is already a distinct contract.
fn push_attendance_branch_filter(builder: &mut QueryBuilder<Postgres>, branch_id: Option<Uuid>) {
    match branch_id {
        Some(branch_id) => {
            builder.push(" l.branch_id = ");
            builder.push_bind(branch_id);
            builder.push(" ");
        }
        None => {
            builder.push(" TRUE ");
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_adapter_postgres::authz::authorize_home_branch_transition;
    use console_hr_adapter_postgres::authz::{
        authorize_exit_confirmation_hq_tier, authorize_hr_scoped_write,
    };
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::directory::create_core::create_employee_core;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_adapter_postgres::directory::read_detail::allowed_lifecycle_events;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_adapter_postgres::directory::read_export::csv_field;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_adapter_postgres::directory::types::EmployeeResponse;
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::directory::types::NormalizedCreateEmployeeRequest;
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::exits::payloads::build_exit_approval_payload;
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::exits::queries::load_exit_case_by_id;
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::exits::settlement::certification_artifact_json;
    use console_hr_adapter_postgres::exits::settlement::compute_certified_package_digest;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_adapter_postgres::exits::settlement::{
        DAILY_CONTRACTUAL_HOURS, MONTHLY_STANDARD_HOURS, ordinary_daily_wage_won_from_monthly,
    };
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::exits::settlement_store::upsert_exit_settlement_package;
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::exits::store::load_exit_case_context;
    #[cfg(feature = "test-postgres")]
    use console_hr_adapter_postgres::exits::types::ExitSettlementInput;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_adapter_postgres::import::canonical::canonical_employee_fields_for_import;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_adapter_postgres::lifecycle::rules::validate_lifecycle_transition;
    use console_hr_domain::import::rrn::contains_rrn_shaped;
    #[cfg(not(feature = "test-postgres"))]
    use console_hr_domain::lifecycle::event::{
        EmployeeForLifecycle, NormalizedEmployeeLifecycleTransition,
    };
    use console_hr_domain::lifecycle::signoffs::EmployeeLifecycleSignoffs;
    #[cfg(feature = "test-postgres")]
    use console_payroll_domain::{ProfessionalReviewerKind, ProfessionalValidation};
    #[cfg(feature = "test-postgres")]
    use console_platform_authz::Role;

    /// Exercises the LIVE custom-grant recheck at the transactional boundary
    /// directly (bypassing the request-time pre-flight): an EXECUTIVE whose
    /// org-wide `employee_directory_manage` grant is revoked after the
    /// principal was minted must be refused 403 by `create_employee_core`
    /// itself, not merely by `authorize_hr_org_wide`.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn create_employee_core_refuses_a_revoked_custom_grant(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        use console_kernel_core::UserId;
        let org_id = Uuid::new_v4();
        let region_id = Uuid::new_v4();
        let branch_id = Uuid::new_v4();
        let actor = UserId::new();
        sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'Grant recheck test')")
            .bind(org_id)
            .bind(format!("grant-recheck-{}", &org_id.to_string()[..8]))
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query("INSERT INTO regions (id,name,org_id) VALUES ($1,$2,$3)")
            .bind(region_id)
            .bind("Grant recheck region")
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query("INSERT INTO branches (id,region_id,name,org_id) VALUES ($1,$2,'본사',$3)")
            .bind(branch_id)
            .bind(region_id)
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO users (id,display_name,roles,is_active,org_id) \
             VALUES ($1,'Executive',ARRAY['EXECUTIVE']::text[],true,$2)",
        )
        .bind(*actor.as_uuid())
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
        let role_id: Uuid = sqlx::query_scalar(
            "INSERT INTO policy_roles (org_id,role_key,display_name,status) \
             VALUES ($1,$2,$3,'ACTIVE') RETURNING id",
        )
        .bind(org_id)
        .bind(format!("grant_recheck_{}", Uuid::new_v4().simple()))
        .bind("Grant recheck role")
        .fetch_one(&pool)
        .await
        .map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO policy_role_permissions (org_id,role_id,feature_key,permission_level) \
             VALUES ($1,$2,'employee_directory_manage','allow')",
        )
        .bind(org_id)
        .bind(role_id)
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
        sqlx::query("INSERT INTO user_role_assignments (org_id,user_id,role_id) VALUES ($1,$2,$3)")
            .bind(org_id)
            .bind(*actor.as_uuid())
            .bind(role_id)
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;

        // Revoke the grant, then invoke the transactional boundary DIRECTLY with
        // the formerly-authorized principal.
        sqlx::query("DELETE FROM user_role_assignments WHERE org_id=$1 AND user_id=$2")
            .bind(org_id)
            .bind(*actor.as_uuid())
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;

        let request = NormalizedCreateEmployeeRequest {
            employee_number: "GRANT-REVOKED".to_owned(),
            name: "Grant revoked".to_owned(),
            company: "테스트".to_owned(),
            employment_type: Some("REGULAR".to_owned()),
            phone_e164: Some("010-1234-5678".to_owned()),
            org_unit: "인사".to_owned(),
            org_unit_id: None,
            position: "사원".to_owned(),
            site: "서울".to_owned(),
            home_branch_id: Some(branch_id),
            base_pay: Some("50000000".to_owned()),
            idempotency_key: "grant-revoked-key".to_owned(),
            hire_date: None,
            contract_start_date: None,
            contract_end_date: None,
            ..Default::default()
        };
        let mut tx = pool.begin().await.map_err(|error| error.to_string())?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await
            .map_err(|error| error.to_string())?;
        let result = create_employee_core(
            &mut tx,
            org_id,
            actor,
            &request,
            "grant-revoked-hash",
            Uuid::new_v4(),
        )
        .await;
        let err = match result {
            Ok(_) => return Err("expected a grant-revoked actor to be refused".to_owned()),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        assert!(
            err.message.contains("grant was revoked"),
            "unexpected message: {}",
            err.message
        );
        tx.rollback().await.map_err(|error| error.to_string())?;
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn frozen_internal_gate_failure_is_redacted_in_the_rest_response() {
        // A gate failure (Internal) carries raw driver diagnostics; the REST
        // mapping must log, not return, them.
        let err = HrError::from(employment::EmploymentError::Frozen(KernelError::internal(
            "period lock check failed: sqlx database connection refused (secret host)",
        )));
        assert_eq!(err.status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(err.code, "internal");
        assert!(!err.message.contains("sqlx"));
        assert!(!err.message.contains("secret host"));

        // A closed window (Conflict) stays actionable, not redacted.
        let refused = HrError::from(employment::EmploymentError::Frozen(KernelError::conflict(
            "payroll period 2026-08-01..2026-08-31 is locked; write refused",
        )));
        assert_eq!(refused.status, StatusCode::CONFLICT);
        assert!(refused.message.contains("locked"));
    }

    /// BW-26. A workbook and a CSV carrying 주민등록번호, 급여, 계좌 and 전화
    /// columns plus RRN-shaped values under innocuous headers go through
    /// preview, dry-run and apply; afterwards no text/json column of any table
    /// in the database holds an RRN-shaped value or a planted restricted value.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn imports_never_persist_restricted_columns_or_rrn_values(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        use axum::extract::FromRequest;
        use console_kernel_core::UserId;

        const PLANTED: [&str; 15] = [
            "900101-1234567",
            "4271953",
            "110-987-654321",
            "010-1234-0002",
            "8001012345678",
            "7501012345678",
            "850505-2345678",
            "010-5555-6666",
            "6602021234567",
            // 010101-3456789 after Excel strips the leading zero.
            "101013456789",
            // An RRN used as a header (form-layout sheet) and as a name.
            "920202-1234567",
            "000000-1000017",
            // RRNs in a file name and a sheet name (both uploads refused).
            "880808-1234567",
            "000000-1000025",
            "010-7777-8888",
        ];
        let org_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        let region_id = Uuid::new_v4();
        sqlx::query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,'BW-26 privacy')")
            .bind(org_id)
            .bind(format!("bw26-{}", &org_id.to_string()[..8]))
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query(
            "INSERT INTO users (id,display_name,roles,is_active,org_id) \
             VALUES ($1,'HR Owner',ARRAY['SUPER_ADMIN']::text[],true,$2)",
        )
        .bind(actor_id)
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|error| error.to_string())?;
        sqlx::query("INSERT INTO regions (id,name,org_id) VALUES ($1,'BW-26 region',$2)")
            .bind(region_id)
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
        sqlx::query("INSERT INTO branches (id,region_id,name,org_id) VALUES ($1,$2,'본사',$3)")
            .bind(Uuid::new_v4())
            .bind(region_id)
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|error| error.to_string())?;
        let command_store = PgLeaveStore::new(
            pool.clone(),
            std::sync::Arc::new(console_inbox_adapter_postgres::PgInboxStore::new(
                pool.clone(),
            )),
        )
        .with_leave_command_pool(pool.clone());
        let state = HrState::new(pool.clone(), None).with_leave_command_store(command_store);
        let principal = Principal::new(
            UserId::from_uuid(actor_id),
            OrgId::from_uuid(org_id),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let upload = |filename: &str, bytes: Vec<u8>| {
            let boundary = "bw26boundary";
            let mut body = Vec::new();
            for (name, value) in [
                ("pay_period_start", "2026-06-01"),
                ("pay_period_end", "2026-06-30"),
            ] {
                body.extend(
                    format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                        .into_bytes(),
                );
            }
            body.extend(
                format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
                     Content-Type: application/octet-stream\r\n\r\n"
                )
                .into_bytes(),
            );
            body.extend(bytes);
            body.extend(format!("\r\n--{boundary}--\r\n").into_bytes());
            axum::http::Request::builder()
                .header(
                    axum::http::header::CONTENT_TYPE,
                    format!("multipart/form-data; boundary={boundary}"),
                )
                .body(axum::body::Body::from(body))
                .map_err(|error| error.to_string())
        };
        let acknowledged = || {
            Some(Json(ImportApplyRequest {
                checklist_all_acknowledged: Some(true),
            }))
        };

        let mut book = umya_spreadsheet::new_file();
        let sheet = book
            .sheet_by_name_mut("Sheet1")
            .map_err(|error| error.to_string())?;
        let header_row = [
            "성명",
            "사번",
            "소속",
            "주민등록번호",
            "급여",
            "계좌",
            "전화",
            "비고",
            "ID번호",
            "920202-1234567",
            "학번",
            "핸드폰",
            "입사일",
        ];
        for (col, header) in header_row.iter().enumerate() {
            sheet.cell_mut((col as u32 + 1, 1)).set_value(*header);
        }
        // BW-10: a new person needs a 입사일; no 소속 leaves them unbound.
        sheet.cell_mut((13, 2)).set_value("2026-06-01");
        for (col, value) in ["홍길동", "E-1001", "", "900101-1234567"]
            .iter()
            .enumerate()
        {
            sheet.cell_mut((col as u32 + 1, 2)).set_value(*value);
        }
        sheet.cell_mut((5, 2)).set_value_number(4_271_953.0);
        sheet.cell_mut((6, 2)).set_value("110-987-654321");
        sheet.cell_mut((7, 2)).set_value("010-1234-0002");
        sheet.cell_mut((8, 2)).set_value("확인용 8001012345678");
        sheet.cell_mut((9, 2)).set_value_number(7_501_012_345_678.0);
        sheet.cell_mut((10, 2)).set_value("양식값");
        sheet.cell_mut((11, 2)).set_value_number(101_013_456_789.0);
        sheet.cell_mut((12, 2)).set_value("010-7777-8888");
        sheet.cell_mut((1, 3)).set_value("000000-1000017");
        let mut xlsx = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut xlsx)
            .map_err(|error| error.to_string())?;

        // A file or sheet name carrying an RRN is refused before anything is
        // stored (the scan below proves no run row was written).
        let multipart =
            Multipart::from_request(upload("직원_880808-1234567.xlsx", xlsx.clone())?, &())
                .await
                .map_err(|error| error.to_string())?;
        let refused = preview_employee_import(
            State(state.clone()),
            Extension(principal.clone()),
            multipart,
        )
        .await;
        assert!(refused.is_err(), "RRN in file name must be refused");
        let mut named = umya_spreadsheet::new_file();
        let named_sheet = named
            .new_sheet("000000-1000025")
            .map_err(|error| error.to_string())?;
        named_sheet.cell_mut((1, 1)).set_value("성명");
        named_sheet.cell_mut((1, 2)).set_value("김철수");
        let mut named_xlsx = Vec::new();
        umya_spreadsheet::writer::xlsx::write_writer(&named, &mut named_xlsx)
            .map_err(|error| error.to_string())?;
        let multipart = Multipart::from_request(upload("직원.xlsx", named_xlsx)?, &())
            .await
            .map_err(|error| error.to_string())?;
        let refused = preview_employee_import(
            State(state.clone()),
            Extension(principal.clone()),
            multipart,
        )
        .await;
        assert!(refused.is_err(), "RRN in a sheet name must be refused");

        let multipart = Multipart::from_request(upload("직원.xlsx", xlsx)?, &())
            .await
            .map_err(|error| error.to_string())?;
        let Json(preview) = preview_employee_import(
            State(state.clone()),
            Extension(principal.clone()),
            multipart,
        )
        .await
        .map_err(|error| format!("employee preview failed: {error:?}"))?;
        let restricted: BTreeSet<&str> = preview
            .columns
            .iter()
            .filter(|column| column.classification == "restricted")
            .map(|column| column.normalized_header.as_str())
            .collect();
        assert_eq!(
            restricted,
            BTreeSet::from(["주민등록번호", "급여", "계좌", "전화", "핸드폰"])
        );
        // The RRN-named row is kept raw-only, never as a candidate.
        assert_eq!(preview.preserved_rows, 1);
        let Json(summary) = dry_run_employee_import(
            State(state.clone()),
            Extension(principal.clone()),
            Path(preview.run_id),
            None,
        )
        .await
        .map_err(|error| format!("employee dry-run failed: {error:?}"))?;
        let response = apply_employee_import(
            State(state.clone()),
            Extension(principal.clone()),
            Path(preview.run_id),
            axum::http::HeaderMap::new(),
            Json(
                console_hr_adapter_postgres::import::types::EmployeeImportApplyRequest {
                    dry_run_digest: summary.dry_run_digest,
                },
            ),
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK, "employee apply failed");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .map_err(|error| error.to_string())?;
        let report: Value = serde_json::from_slice(&body).map_err(|error| error.to_string())?;
        assert_eq!(report["inserted"], 1);

        let csv = "사번,성명,지점,근무일,출근,퇴근,주민번호,연락처,메모\n\
                   E-1001,홍길동,본사,2026-06-01,09:00,18:00,850505-2345678,010-5555-6666,6602021234567\n";
        let multipart = Multipart::from_request(upload("근태.csv", csv.as_bytes().to_vec())?, &())
            .await
            .map_err(|error| error.to_string())?;
        let Json(attendance) = preview_attendance_import(
            State(state.clone()),
            Extension(principal.clone()),
            multipart,
        )
        .await
        .map_err(|error| format!("attendance preview failed: {error:?}"))?;
        let _summary = dry_run_attendance_import(
            State(state.clone()),
            Extension(principal.clone()),
            Path(attendance.run_id),
        )
        .await
        .map_err(|error| format!("attendance dry-run failed: {error:?}"))?;
        let Json(applied) = apply_attendance_import(
            State(state.clone()),
            Extension(principal.clone()),
            Path(attendance.run_id),
            acknowledged(),
        )
        .await
        .map_err(|error| format!("attendance apply failed: {error:?}"))?;
        assert_eq!(applied.inserted, 1);

        // Every text/json column of every table: one count per column, run
        // server-side so the identifiers are quoted by format(%I).
        let hits = |pattern: &'static str, needles: Vec<String>| {
            sqlx::query_scalar::<_, String>(
                "SELECT c.table_schema || '.' || c.table_name || '.' || c.column_name \
                 FROM information_schema.columns c \
                 JOIN information_schema.tables t \
                   ON t.table_schema = c.table_schema AND t.table_name = c.table_name \
                 WHERE t.table_type = 'BASE TABLE' \
                   AND c.table_schema NOT IN ('pg_catalog', 'information_schema') \
                   AND c.udt_name IN ('text','varchar','bpchar','json','jsonb','_text','_varchar','citext') \
                   AND (xpath('/row/n/text()', query_to_xml(format( \
                        'SELECT count(*) AS n FROM %I.%I WHERE %I::text ~ %L OR %I::text LIKE ANY (%L::text[])', \
                        c.table_schema, c.table_name, c.column_name, $1, c.column_name, $2), \
                        false, true, '')))[1]::text::bigint > 0 \
                 ORDER BY 1",
            )
            .bind(pattern)
            .bind(needles)
            .fetch_all(&pool)
        };
        // Positive control: the scan reaches imported data at all (RLS would
        // otherwise make every count silently zero).
        let control = hits("$^", vec!["%E-1001%".to_owned()])
            .await
            .map_err(|error| error.to_string())?;
        for expected in [
            "public.employees.employee_number",
            "public.data_import_rows.raw_row",
        ] {
            assert!(
                control.contains(&expected.to_owned()),
                "scan missed {expected}: {control:?}"
            );
        }
        let leaks = hits(
            r"(^|[^0-9A-Za-z])[0-9]{6}-?[1-8][0-9]{6}([^0-9A-Za-z]|$)",
            PLANTED.iter().map(|value| format!("%{value}%")).collect(),
        )
        .await
        .map_err(|error| error.to_string())?;
        assert!(
            leaks.is_empty(),
            "restricted import values persisted in {leaks:?}"
        );
        Ok(())
    }

    #[test]
    fn rrn_shape_matches_only_thirteen_digit_runs_with_a_valid_gender_digit() {
        for hit in [
            "900101-1234567",
            "9001011234567",
            "9001011234567.0",
            "RRN 800101-2345678 확인",
            "050505-4123457",
        ] {
            assert!(contains_rrn_shaped(hit), "{hit} must match");
        }
        for miss in [
            "900101-9234567",
            "900101-0234567",
            "90010112345678",
            "19001011234567",
            "010-1234-5678",
            "110-987-654321",
            "900101-123456",
            "",
        ] {
            assert!(!contains_rrn_shaped(miss), "{miss} must not match");
        }
        // Excel strips the leading zero of a 2000s birth year.
        for hit in [
            "101013456789",
            "101013456789.0",
            "11013412346",
            "900101-1234567",
        ] {
            assert!(is_rrn_value(hit), "{hit} must match");
        }
        // A 10-digit 사번 and a phone number keep their leading zero rule; a
        // long 사번 that is no 2000s birth date and gender digit is kept.
        for miss in ["2024000123", "01012345678", "10101345678", "123456123456"] {
            assert!(!is_rrn_value(miss), "{miss} must not match");
        }
    }

    #[test]
    fn import_rows_drop_restricted_columns_and_rrn_values_but_name_them() {
        let headers = [
            "성명",
            "주민등록번호",
            "급여",
            "개인주소",
            "근무지(주소)",
            "ID번호",
            "메모",
            "",
        ]
        .map(ToOwned::to_owned);
        let cells = [
            json!("홍길동"),
            json!("900101-1234567"),
            json!(4_271_953),
            json!("서울"),
            json!("본사"),
            json!(7_501_012_345_678_i64),
            Value::Null,
            json!("ignored"),
        ];
        let (raw, dropped) = persistable_import_row(
            &headers,
            |idx| cells[idx].clone(),
            is_dropped_employee_import_header,
        );
        assert_eq!(
            raw,
            json!({ "성명": "홍길동", "근무지(주소)": "본사", "메모": null })
        );
        assert_eq!(dropped, ["주민등록번호", "급여", "개인주소", "ID번호"]);
        assert_eq!(
            employee_import_column_classification("개인주소", None),
            "restricted"
        );
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn attendance_import_csv_parses_valid_rows_and_masks_preview_values() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,출근시간,퇴근시간,근무분,급여메모
E-001,=홍길동,본사,2026-07-01,09:00,18:00,540,=cmd|' /C calc'!A0
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes(), &[])
            .map_err(|err| format!("expected attendance CSV to parse, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Candidate);
        assert_eq!(parsed.rows[0].employee_number.as_deref(), Some("E-001"));
        assert_eq!(parsed.rows[0].employee_name.as_deref(), Some("=홍길동"));
        assert_eq!(parsed.rows[0].branch_name.as_deref(), Some("본사"));
        assert_eq!(parsed.rows[0].minutes_worked, Some(540));
        assert_eq!(parsed.rows[0].work_date.as_deref(), Some("2026-07-01"));
        assert_eq!(parsed.rows[0].source_key, "sheet:CSV|row:2");

        let response = AttendanceImportPreviewResponse::from_rows(
            Uuid::nil(),
            "attendance.csv".to_owned(),
            "0".repeat(64),
            parsed.rows,
        );
        let values = &response.sample_rows[0].values;
        assert_eq!(values.get("성명"), Some(&json!("'=홍길동")));
        assert_eq!(values.get("급여메모"), None);
        assert!(response.columns.iter().any(|column| {
            column.normalized_header == "급여메모" && column.classification == "restricted"
        }));
        assert_eq!(
            response.mapping_profile["policy"]["payroll_effect"],
            json!("lineage_only_not_payable")
        );
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn attendance_import_marks_missing_employee_and_duplicate_rows() -> Result<(), String> {
        let missing_employee_csv = "\
사번,성명,지점,근무일,출근시간
,,본사,2026-07-01,09:00
";
        let parsed =
            parse_attendance_import_upload("attendance.csv", missing_employee_csv.as_bytes(), &[])
                .map_err(|err| format!("expected row-level validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"missing_employee_identifier".to_owned())
        );

        let duplicate_csv = "\
사번,성명,지점,근무일,출근시간,퇴근시간
E-001,홍길동,본사,2026-07-01,09:00,18:00
E-001,홍길동,본사,2026-07-01,09:00,18:00
";
        let duplicate =
            parse_attendance_import_upload("attendance.csv", duplicate_csv.as_bytes(), &[])
                .map_err(|err| format!("expected duplicate row validation, got {err:?}"))?;

        assert_eq!(duplicate.rows.len(), 2);
        assert!(
            duplicate
                .rows
                .iter()
                .all(|row| row.row_status == ImportRowStatus::Error)
        );
        assert!(duplicate.rows.iter().all(|row| {
            row.validation_errors
                .contains(&"duplicate_row_in_file".to_owned())
        }));
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn attendance_import_rejects_invalid_work_date() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,출근시간
E-001,홍길동,본사,45500,09:00
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes(), &[])
            .map_err(|err| format!("expected row-level work-date validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"invalid_work_date".to_owned())
        );
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn attendance_import_rejects_invalid_attendance_time() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,출근시간
E-001,홍길동,본사,2026-07-01,25:99
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes(), &[])
            .map_err(|err| format!("expected row-level time validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"invalid_check_in_at".to_owned())
        );
        Ok(())
    }
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn attendance_import_resolves_dedups_and_enforces_runtime_guards(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let org_id = Uuid::new_v4();
        let branch_id = Uuid::new_v4();
        let region_id = Uuid::new_v4();
        let employee_id = Uuid::new_v4();
        let run_id = Uuid::new_v4();
        let ready_row_id = Uuid::new_v4();
        let duplicate_row_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let mailbox_domain_id = Uuid::new_v4();
        let mailbox_id = Uuid::new_v4();
        let mailbox_alias_id = Uuid::new_v4();
        let mailbox_message_id = Uuid::new_v4();
        let mailbox_delivery_id = Uuid::new_v4();
        let source_sha256 = "a".repeat(64);

        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(format!("attendance-{}", &org_id.to_string()[..8]))
            .bind("Attendance Import Test")
            .execute(&pool)
            .await
            .map_err(|err| format!("seed organization failed: {err}"))?;
        sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
            .bind(region_id)
            .bind(format!("Attendance Region {}", &region_id.to_string()[..8]))
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed region failed: {err}"))?;
        sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
            .bind(branch_id)
            .bind(region_id)
            .bind("본사")
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed branch failed: {err}"))?;
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, $2, ARRAY['ADMIN']::TEXT[], true, $3)",
        )
        .bind(user_id)
        .bind("Mailbox Force Remove Owner")
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox owner user failed: {err}"))?;
        let mailbox_domain = format!("attendance-{}.example.test", &org_id.to_string()[..8]);
        sqlx::query(
            r#"
            INSERT INTO mailbox_domains (
                id, org_id, domain, created_by
            )
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(mailbox_domain_id)
        .bind(org_id)
        .bind(&mailbox_domain)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox domain failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailboxes (
                id, org_id, domain_id, local_part, display_name, mailbox_kind, created_by
            )
            VALUES ($1, $2, $3, 'ops', 'Ops Mailbox', 'SHARED', $4)
            "#,
        )
        .bind(mailbox_id)
        .bind(org_id)
        .bind(mailbox_domain_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailbox_aliases (
                id, org_id, domain_id, target_mailbox_id, local_part, created_by
            )
            VALUES ($1, $2, $3, $4, 'alias', $5)
            "#,
        )
        .bind(mailbox_alias_id)
        .bind(org_id)
        .bind(mailbox_domain_id)
        .bind(mailbox_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox alias failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailbox_messages (
                id, org_id, mailbox_id, domain_id, direction,
                raw_object_key, raw_size_bytes, received_at
            )
            VALUES ($1, $2, $3, $4, 'IN', 'raw-object-12345678', 0, now())
            "#,
        )
        .bind(mailbox_message_id)
        .bind(org_id)
        .bind(mailbox_id)
        .bind(mailbox_domain_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox message failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO mailbox_deliveries (
                id, org_id, mailbox_message_id, direction, status,
                recipient_domain, recipient_local_part, queue_key,
                accepted_at, completed_at
            )
            VALUES ($1, $2, $3, 'IN', 'STORED', $4, 'ops', $5, now(), now())
            "#,
        )
        .bind(mailbox_delivery_id)
        .bind(org_id)
        .bind(mailbox_message_id)
        .bind(&mailbox_domain)
        .bind(format!("queue-{}", mailbox_delivery_id))
        .execute(&pool)
        .await
        .map_err(|err| format!("seed mailbox delivery failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employees (
                id, org_id, company, name, employee_number, source_filename,
                source_sheet, source_row, source_key, raw_row, source_metadata
            )
            VALUES ($1, $2, '테스트', '홍길동', NULL, 'employees.xlsx', '직원', 2, 'employee-row-2', '{}', '{}')
            "#,
        )
        .bind(employee_id)
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed employee failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employee_lifecycle_events (
                org_id, employee_id, event_type, to_status, effective_date, comment, created_by
            )
            VALUES ($1, $2, 'ONBOARD', 'ACTIVE', '2026-07-01', 'force-remove test lifecycle event', $3)
            "#,
        )
        .bind(org_id)
        .bind(employee_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed lifecycle event failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO data_import_runs (
                id, org_id, entity_type, status, source_filename, source_format,
                source_sha256, mapping_profile, input_rows, candidate_rows, preserved_rows,
                pay_period_start, pay_period_end
            )
            VALUES ($1, $2, 'attendance_direct', 'DRY_RUN', 'attendance.csv', 'csv', $3, '{}', 2, 2, 0, DATE '2026-06-01', DATE '2026-06-30')
            "#,
        )
        .bind(run_id)
        .bind(org_id)
        .bind(&source_sha256)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed import run failed: {err}"))?;

        let ready_canonical = json!({
            "source_sheet": "CSV",
            "source_row": 2,
            "source_key": "sheet:CSV|row:2",
            "source_sha256": source_sha256,
            "canonical": {
                "employee_number": null,
                "employee_name": "홍길동",
                "branch_name": "본사",
                "work_date": "2026-07-01",
                "check_in_at": "09:00",
                "check_out_at": "18:00",
                "minutes_worked": 540
            }
        });
        let duplicate_canonical = json!({
            "source_sheet": "CSV",
            "source_row": 3,
            "source_key": "sheet:CSV|row:3",
            "source_sha256": source_sha256,
            "canonical": {
                "employee_number": null,
                "employee_name": "홍길동",
                "branch_name": "본사",
                "work_date": "2026-07-02",
                "check_in_at": "09:00",
                "check_out_at": "18:00",
                "minutes_worked": 540
            }
        });
        for (row_id, source_row, source_key, canonical) in [
            (ready_row_id, 2, "sheet:CSV|row:2", ready_canonical),
            (duplicate_row_id, 3, "sheet:CSV|row:3", duplicate_canonical),
        ] {
            sqlx::query(
                r#"
                INSERT INTO data_import_rows (
                    id, org_id, run_id, source_sheet, source_row, source_key,
                    row_status, raw_row, canonical_row, validation
                )
                VALUES ($1, $2, $3, 'CSV', $4, $5, 'CANDIDATE', '{}', $6, '{"status":"ok","errors":[],"warnings":[]}')
                "#,
            )
            .bind(row_id)
            .bind(org_id)
            .bind(run_id)
            .bind(source_row)
            .bind(source_key)
            .bind(canonical)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed import row {source_key} failed: {err}"))?;
        }
        let existing_fact_key = attendance_fact_key(
            employee_id,
            branch_id,
            "2026-07-02",
            Some("09:00"),
            Some("18:00"),
            Some(540),
        );
        sqlx::query(
            r#"
            INSERT INTO attendance_direct_import_events (
                org_id, run_id, import_row_id, employee_id, branch_id,
                source_sheet, source_row, source_key, source_sha256, fact_key,
                employee_number, employee_name, branch_name, work_date,
                check_in_at, check_out_at, minutes_worked
            )
            VALUES ($1, $2, $3, $4, $5, 'CSV', 99, 'sheet:CSV|row:99', $6, $7,
                    NULL, '홍길동', '본사', '2026-07-02', '09:00', '18:00', 540)
            "#,
        )
        .bind(org_id)
        .bind(run_id)
        .bind(duplicate_row_id)
        .bind(employee_id)
        .bind(branch_id)
        .bind(&source_sha256)
        .bind(&existing_fact_key)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed existing attendance event failed: {err}"))?;

        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin dry-run transaction failed: {err}"))?;
        let run = import_run_for_update(&mut tx, org_id, run_id)
            .await
            .map_err(|err| format!("load import run failed: {err:?}"))?;
        ensure_attendance_import_run(&run, &["DRY_RUN"])
            .map_err(|err| format!("status gate failed: {err:?}"))?;
        let rows = load_attendance_import_rows(&mut tx, org_id, run_id)
            .await
            .map_err(|err| format!("load import rows failed: {err:?}"))?;
        let summary = resolve_attendance_import_rows(&mut tx, org_id, run_id, &run, &rows)
            .await
            .map_err(|err| format!("resolve import rows failed: {err:?}"))?;
        tx.rollback()
            .await
            .map_err(|err| format!("rollback dry-run transaction failed: {err}"))?;

        assert_eq!(summary.ready_rows, 1);
        assert_eq!(summary.duplicate_rows, 1);
        assert_eq!(summary.error_rows, 1);
        assert_eq!(summary.ready_rows_for_apply[0].employee_id, employee_id);
        assert_eq!(summary.ready_rows_for_apply[0].employee_number, None);
        assert!(
            summary
                .row_errors
                .iter()
                .any(|error| error.code == "duplicate_attendance_fact")
        );

        let update_result = sqlx::query(
            "UPDATE attendance_direct_import_events SET employee_name = '위조' WHERE org_id = $1 AND run_id = $2",
        )
        .bind(org_id)
        .bind(run_id)
        .execute(&pool)
        .await;
        assert!(
            update_result.is_err(),
            "append-only attendance import events must reject UPDATE"
        );

        let mut rls_tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin rls transaction failed: {err}"))?;
        sqlx::query("SET LOCAL ROLE console_rt")
            .execute(rls_tx.as_mut())
            .await
            .map_err(|err| format!("set runtime role failed: {err}"))?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(rls_tx.as_mut())
            .await
            .map_err(|err| format!("set current org failed: {err}"))?;
        let visible_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attendance_direct_import_events")
                .fetch_one(rls_tx.as_mut())
                .await
                .map_err(|err| format!("runtime select failed: {err}"))?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(Uuid::new_v4().to_string())
            .execute(rls_tx.as_mut())
            .await
            .map_err(|err| format!("set other org failed: {err}"))?;
        let hidden_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM attendance_direct_import_events")
                .fetch_one(rls_tx.as_mut())
                .await
                .map_err(|err| format!("runtime isolation select failed: {err}"))?;
        rls_tx
            .rollback()
            .await
            .map_err(|err| format!("rollback rls transaction failed: {err}"))?;

        assert_eq!(visible_rows, 1);
        assert_eq!(hidden_rows, 0);
        sqlx::query("UPDATE organizations SET status = 'ARCHIVED' WHERE id = $1")
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| format!("archive organization failed: {err}"))?;
        let force_remove_result: String =
            sqlx::query_scalar("SELECT platform_force_remove_organization($1)")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("force-remove organization failed: {err}"))?;
        assert_eq!(force_remove_result, "removed");
        let remaining_import_rows: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM data_import_rows WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("count remaining import rows failed: {err}"))?;
        let remaining_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM attendance_direct_import_events WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count remaining attendance events failed: {err}"))?;
        let remaining_mailbox_rows: i64 = sqlx::query_scalar(
            r#"
            SELECT
                (SELECT COUNT(*) FROM mailbox_deliveries WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailbox_messages WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailbox_aliases WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailboxes WHERE org_id = $1)
              + (SELECT COUNT(*) FROM mailbox_domains WHERE org_id = $1)
            "#,
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count remaining mailbox rows failed: {err}"))?;
        let remaining_lifecycle_events: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM employee_lifecycle_events WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("count remaining lifecycle events failed: {err}"))?;
        assert_eq!(remaining_import_rows, 0);
        assert_eq!(remaining_events, 0);
        assert_eq!(remaining_mailbox_rows, 0);
        assert_eq!(remaining_lifecycle_events, 0);
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn attendance_import_keeps_invalid_minutes_as_row_error() -> Result<(), String> {
        let csv = "\
사번,성명,지점,근무일,근무분
E-001,홍길동,본사,2026-07-01,abc
";
        let parsed = parse_attendance_import_upload("attendance.csv", csv.as_bytes(), &[])
            .map_err(|err| format!("expected row-level minutes validation, got {err:?}"))?;

        assert_eq!(parsed.rows.len(), 1);
        assert_eq!(parsed.rows[0].row_status, ImportRowStatus::Error);
        assert!(
            parsed.rows[0]
                .validation_errors
                .contains(&"invalid_minutes_worked".to_owned())
        );
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn attendance_import_rejects_unclosed_csv_quote() -> Result<(), String> {
        let err = match parse_csv_rows("\"unterminated") {
            Ok(rows) => return Err(format!("unclosed quote unexpectedly parsed as {rows:?}")),
            Err(err) => err,
        };
        assert_eq!(err.code, "workbook");
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn canonical_employee_fields_extract_hr_safe_columns() {
        let raw = json!({
            "사번": "A-001",
            "부서명": "물류팀",
            "업무": "정비",
            "직책": "대리",
            "근무지": "인천센터",
            "근무지(주소)": "인천광역시",
            "입사일": "2024-01-02",
            "발생연차": "15.00",
            "사용연차": "7.50",
            "잔여연차": "7.50"
        });

        let canonical = canonical_employee_fields_for_import(&raw, &[]);

        assert_eq!(canonical.employee_number.as_deref(), Some("A-001"));
        assert_eq!(canonical.org_unit.as_deref(), Some("물류팀"));
        assert_eq!(canonical.position.as_deref(), Some("대리"));
        assert_eq!(canonical.worksite_name.as_deref(), Some("인천센터"));
        assert_eq!(canonical.employment_status, "ACTIVE");
        assert_eq!(canonical.leave_accrued.as_deref(), Some("15.000000"));
        assert_eq!(canonical.leave_used.as_deref(), Some("7.500000"));
        assert_eq!(canonical.leave_remaining.as_deref(), Some("7.500000"));
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn canonical_employee_fields_marks_exited_people_without_deleting_raw_data() {
        let raw = json!({
            "성명": "이퇴사",
            "퇴사일": "2026-01-31",
            "퇴직금 중간정산일": "2025-12-31"
        });

        let canonical = canonical_employee_fields_for_import(&raw, &[]);

        assert_eq!(canonical.exit_date.as_deref(), Some("2026-01-31"));
        assert_eq!(canonical.employment_status, "EXITED");
        assert_eq!(raw["퇴직금 중간정산일"], json!("2025-12-31"));
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn standardized_csv_neutralizes_spreadsheet_formulas() {
        assert_eq!(csv_field("=cmd|' /C calc'!A0"), "'=cmd|' /C calc'!A0");
        assert_eq!(csv_field("hello, world"), "\"hello, world\"");
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn employee_response_serializes_canonical_fields_without_import_provenance()
    -> Result<(), String> {
        let body = serde_json::to_value(EmployeeResponse {
            id: Uuid::nil(),
            company: "새온".to_owned(),
            name: "홍길동".to_owned(),
            employee_number: Some("A-001".to_owned()),
            org_unit: Some("물류팀".to_owned()),
            org_unit_id: None,
            legal_entity_id: None,
            workplace_id: None,
            worksite_name: None,
            worksite: None,
            job: None,
            position: Some("대리".to_owned()),
            hire_date: Some("2024-01-02".to_owned()),
            exit_date: None,
            status: Some("ACTIVE".to_owned()),
            leave_accrued: None,
            leave_used: None,
            leave_remaining: None,
            home_branch_id: None,
            home_branch_name: None,
            home_branch_review_required: true,
            register_review_required: true,
            identity_resolution_strategy: "employee_number".to_owned(),
            identity_resolution_confidence: "high".to_owned(),
            identity_review_required: false,
            identity_name_only_merge: false,
            contract_end_date: None,
            employment_type: None,
            expected_return_date: None,
            work_email: None,
            next_event: None,
            failed_event: None,
            created_at: time::OffsetDateTime::UNIX_EPOCH,
            updated_at: time::OffsetDateTime::UNIX_EPOCH,
        })
        .map_err(|err| format!("employee response serialization failed: {err}"))?;

        for forbidden in [
            "raw_row",
            "source_metadata",
            "source_filename",
            "source_sheet",
            "source_row",
        ] {
            assert!(
                body.get(forbidden).is_none(),
                "public employee response must not expose {forbidden}",
            );
        }
        assert_eq!(
            body["identity_resolution_strategy"],
            json!("employee_number")
        );
        assert_eq!(body["identity_resolution_confidence"], json!("high"));
        assert_eq!(body["identity_review_required"], json!(false));
        assert_eq!(body["identity_name_only_merge"], json!(false));
        assert_eq!(body["home_branch_review_required"], json!(true));
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn employee_identity_resolution_rejects_name_only_and_untrusted_confidence() {
        let metadata = json!({
            "identity_resolution": {
                "strategy": "source_row_fingerprint",
                "confidence": "high",
                "manual_review_required": true,
                "name_only_merge": true
            }
        });

        let identity = employee_identity_resolution_from_metadata(&metadata);

        assert_eq!(identity.strategy, "source_row_fingerprint");
        assert_eq!(identity.confidence, "low");
        assert!(identity.review_required);
        assert!(!identity.name_only_merge);
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn employee_identity_resolution_accepts_high_confidence_trusted_strategies() {
        let metadata = json!({
            "identity_resolution": {
                "strategy": "legal_identifier_hash",
                "manual_review_required": false
            }
        });

        let identity = employee_identity_resolution_from_metadata(&metadata);

        assert_eq!(identity.strategy, "legal_identifier_hash");
        assert_eq!(identity.confidence, "high");
        assert!(!identity.review_required);
        assert!(!identity.name_only_merge);
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn employee_identity_resolution_keeps_weak_strategies_review_required() {
        let metadata = json!({
            "identity_resolution": {
                "strategy": "birth_hire_fingerprint",
                "manual_review_required": false
            }
        });

        let identity = employee_identity_resolution_from_metadata(&metadata);

        assert_eq!(identity.strategy, "birth_hire_fingerprint");
        assert_eq!(identity.confidence, "medium");
        assert!(identity.review_required);
        assert!(!identity.name_only_merge);
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn org_wide_hr_authorization_rejects_branch_scoped_principals() -> Result<(), String> {
        use console_kernel_core::{BranchId, OrgId, UserId};
        use console_platform_authz::Role;
        use std::collections::BTreeSet;

        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(BranchId::new()),
        );

        let err = match authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryRead) {
            Ok(()) => {
                return Err(
                    "branch-scoped HR read authorized an org-wide employee surface".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::FORBIDDEN);
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn org_wide_hr_authorization_uses_core_org_wide_gate() -> Result<(), String> {
        use console_kernel_core::{OrgId, UserId};
        use console_platform_authz::Role;
        use std::collections::BTreeSet;

        let admin = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::All,
        );

        let admin_err = match authorize_hr_org_wide(&admin, Feature::EmployeeDirectoryRead) {
            Ok(()) => {
                return Err(
                    "synthetic all-branch ADMIN authorized an org-wide employee surface".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(admin_err.status, StatusCode::FORBIDDEN);

        let executive = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Executive]),
            BranchScope::All,
        );

        authorize_hr_org_wide(&executive, Feature::EmployeeDirectoryRead)
            .map_err(|err| format!("org-wide executive HR read was rejected: {}", err.message))?;
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn scoped_hr_authorization_checks_the_complete_scope_without_picking_a_branch()
    -> Result<(), String> {
        use console_kernel_core::{BranchId, OrgId, UserId};
        use console_platform_authz::{EffectiveFeatureGrant, PermissionLevel, Role};
        use std::collections::BTreeSet;

        let branch_a = BranchId::new();
        let branch_b = BranchId::new();
        let scope = BranchScope::Branches(BTreeSet::from([branch_a, branch_b]));

        let admin = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            scope.clone(),
        );
        authorize_hr_scoped(&admin, Feature::EmployeeDirectoryRead)
            .map_err(|err| format!("branch-scoped ADMIN was rejected: {}", err.message))?;
        authorize_hr_scoped_write(&admin, Feature::ExitCaseReport, Some(*branch_a.as_uuid()))
            .map_err(|err| format!("in-branch exit write was rejected: {}", err.message))?;
        assert!(
            authorize_hr_scoped_write(
                &admin,
                Feature::ExitCaseReport,
                Some(*BranchId::new().as_uuid()),
            )
            .is_err(),
            "a concrete foreign-branch write must be denied"
        );
        assert!(
            authorize_hr_scoped_write(&admin, Feature::ExitCaseReport, None).is_err(),
            "a branchless write must require org-wide authority"
        );

        let empty = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::none(),
        );
        assert!(
            authorize_hr_scoped(&empty, Feature::EmployeeDirectoryRead).is_err(),
            "an empty branch scope must fail closed"
        );

        let partial_grant =
            Principal::new(UserId::new(), OrgId::new(), BTreeSet::new(), scope.clone())
                .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                    Feature::EmployeeDirectoryRead,
                    PermissionLevel::Allow,
                    BranchScope::single(branch_a),
                )]);
        assert!(
            authorize_hr_scoped(&partial_grant, Feature::EmployeeDirectoryRead).is_err(),
            "a grant over only one of two visible branches must not authorize the whole read"
        );

        let covering_grant =
            Principal::new(UserId::new(), OrgId::new(), BTreeSet::new(), scope.clone())
                .with_effective_feature_grants(vec![EffectiveFeatureGrant::new(
                    Feature::EmployeeDirectoryRead,
                    PermissionLevel::Allow,
                    scope,
                )]);
        authorize_hr_scoped(&covering_grant, Feature::EmployeeDirectoryRead)
            .map_err(|err| format!("covering HR grant was rejected: {}", err.message))?;

        let all_admin = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::All,
        );
        assert!(
            authorize_hr_scoped(&all_admin, Feature::EmployeeDirectoryRead).is_err(),
            "the existing all-scope ADMIN denial must be preserved"
        );

        let super_admin = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        authorize_hr_scoped_write(&super_admin, Feature::ExitCaseReport, None).map_err(|err| {
            format!(
                "org-wide branchless exit write was rejected: {}",
                err.message
            )
        })?;
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn home_branch_assignment_requires_org_wide_authority_when_unassigned() -> Result<(), String> {
        use console_kernel_core::{OrgId, UserId};
        use console_platform_authz::Role;
        use std::collections::BTreeSet;

        let branch = BranchId::new();
        let branch_admin = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(branch),
        );
        let err = authorize_home_branch_transition(&branch_admin, None, *branch.as_uuid())
            .expect_err("branch admin must not claim an unassigned employee");
        assert_eq!(err.status, StatusCode::FORBIDDEN);

        let super_admin = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        authorize_home_branch_transition(&super_admin, None, *branch.as_uuid())
            .map_err(|err| err.message)?;
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[tokio::test]
    async fn home_branch_assignment_fails_closed_without_command_pool() -> Result<(), String> {
        use console_kernel_core::{OrgId, UserId};
        use console_platform_authz::Role;
        use sqlx::postgres::PgPoolOptions;
        use std::collections::BTreeSet;

        let branch = BranchId::new();
        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let pool = PgPoolOptions::new()
            .connect_lazy("postgresql://unused:unused@127.0.0.1/unused")
            .map_err(|err| err.to_string())?;

        let err = set_employee_home_branch(
            State(HrState::new(pool, None)),
            Extension(principal),
            Path(Uuid::new_v4()),
            Json(SetEmployeeHomeBranchRequest {
                branch_id: *branch.as_uuid(),
                expected_updated_at: "2026-07-19T12:00:00Z".to_owned(),
            }),
        )
        .await
        .expect_err("missing leave command database must fail closed");

        assert_eq!(err.0.status, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(err.0.code, "service_unavailable");
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn home_branch_reassignment_requires_authority_over_old_and_new_branch() {
        use console_kernel_core::{OrgId, UserId};
        use console_platform_authz::Role;
        use std::collections::BTreeSet;

        let old_branch = BranchId::new();
        let new_branch = BranchId::new();
        let new_branch_only = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::single(new_branch),
        );
        assert_eq!(
            authorize_home_branch_transition(
                &new_branch_only,
                Some(*old_branch.as_uuid()),
                *new_branch.as_uuid(),
            )
            .expect_err("new-branch authority alone must not move an employee")
            .status,
            StatusCode::FORBIDDEN,
        );

        let both = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::from([Role::Admin]),
            BranchScope::Branches(BTreeSet::from([old_branch, new_branch])),
        );
        assert!(
            authorize_home_branch_transition(
                &both,
                Some(*old_branch.as_uuid()),
                *new_branch.as_uuid(),
            )
            .is_ok()
        );
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn home_branch_assignment_is_explicit_versioned_and_audited(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        use console_kernel_core::{OrgId, UserId};
        use console_platform_authz::Role;
        use std::collections::BTreeSet;

        let org_id = Uuid::new_v4();
        let region_id = Uuid::new_v4();
        let branch_id = Uuid::new_v4();
        let inactive_branch_id = Uuid::new_v4();
        let employee_id = Uuid::new_v4();
        let actor_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'Home Branch Test')",
        )
        .bind(org_id)
        .bind(format!("home-branch-{}", &org_id.to_string()[..8]))
        .execute(&pool)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
            .bind(region_id)
            .bind(format!("Home Branch Region {region_id}"))
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| err.to_string())?;
        sqlx::query(
            "INSERT INTO branches (id, region_id, name, org_id, deactivated_at) VALUES ($1, $2, 'Active', $3, NULL), ($4, $2, 'Inactive', $3, now())",
        )
        .bind(branch_id)
        .bind(region_id)
        .bind(org_id)
        .bind(inactive_branch_id)
        .execute(&pool)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, 'HR Owner', ARRAY['SUPER_ADMIN']::TEXT[], true, $2)",
        )
        .bind(actor_id)
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|err| err.to_string())?;
        sqlx::query(
            "INSERT INTO employees (id, org_id, company, name, source_filename, source_sheet, source_row, source_key, raw_row, source_metadata) VALUES ($1, $2, 'Test', 'Employee', 'test.xlsx', 'Sheet', 1, 'home-branch-employee', '{}', '{}')",
        )
        .bind(employee_id)
        .bind(org_id)
        .execute(&pool)
        .await
        .map_err(|err| err.to_string())?;
        let expected_updated_at: OffsetDateTime =
            sqlx::query_scalar("SELECT updated_at FROM employees WHERE id = $1")
                .bind(employee_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| err.to_string())?;
        let principal = Principal::new(
            UserId::from_uuid(actor_id),
            OrgId::from_uuid(org_id),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let command_store = PgLeaveStore::new(
            pool.clone(),
            std::sync::Arc::new(console_inbox_adapter_postgres::PgInboxStore::new(
                pool.clone(),
            )),
        )
        .with_leave_command_pool(pool.clone());
        let response = set_employee_home_branch(
            State(HrState::new(pool.clone(), None).with_leave_command_store(command_store.clone())),
            Extension(principal.clone()),
            Path(employee_id),
            Json(SetEmployeeHomeBranchRequest {
                branch_id,
                expected_updated_at: expected_updated_at
                    .format(&time::format_description::well_known::Rfc3339)
                    .map_err(|err| err.to_string())?,
            }),
        )
        .await
        .map_err(|err| err.0.message)?;
        assert_eq!(response.0.branch_id, branch_id);
        let stored: Option<Uuid> =
            sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id = $1")
                .bind(employee_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| err.to_string())?;
        assert_eq!(stored, Some(branch_id));
        let audits: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM audit_events WHERE org_id = $1 AND target_id = $2 AND action = 'employee.home_branch_set' AND actor = $3 AND before_snap->>'home_branch_id' IS NULL AND after_snap->>'home_branch_id' = $4",
        )
        .bind(org_id)
        .bind(employee_id.to_string())
        .bind(actor_id)
        .bind(branch_id.to_string())
        .fetch_one(&pool)
        .await
        .map_err(|err| err.to_string())?;
        assert_eq!(audits, 1);

        let inactive_err = set_employee_home_branch(
            State(HrState::new(pool.clone(), None).with_leave_command_store(command_store)),
            Extension(principal),
            Path(employee_id),
            Json(SetEmployeeHomeBranchRequest {
                branch_id: inactive_branch_id,
                expected_updated_at: response
                    .0
                    .updated_at
                    .format(&time::format_description::well_known::Rfc3339)
                    .map_err(|err| err.to_string())?,
            }),
        )
        .await
        .expect_err("deactivated branch must not become authoritative");
        assert_eq!(inactive_err.0.status, StatusCode::NOT_FOUND);
        Ok(())
    }
    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn employee_attendance_state_machine_accepts_mobile_pc_workday_flow() -> Result<(), String> {
        assert_eq!(
            next_employee_attendance_state(None, "CLOCK_IN").map_err(|err| err.message.clone())?,
            "CLOCKED_IN"
        );
        assert_eq!(
            next_employee_attendance_state(Some("CLOCKED_IN"), "OUT_FOR_WORK")
                .map_err(|err| err.message.clone())?,
            "OUT_FOR_WORK"
        );
        assert_eq!(
            next_employee_attendance_state(Some("OUT_FOR_WORK"), "RETURNED")
                .map_err(|err| err.message.clone())?,
            "CLOCKED_IN"
        );
        assert_eq!(
            next_employee_attendance_state(Some("CLOCKED_IN"), "BUSINESS_TRIP")
                .map_err(|err| err.message.clone())?,
            "BUSINESS_TRIP"
        );
        assert_eq!(
            next_employee_attendance_state(Some("BUSINESS_TRIP"), "CLOCK_OUT")
                .map_err(|err| err.message.clone())?,
            "OFF_DUTY"
        );
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn employee_attendance_state_machine_rejects_invalid_duplicate_punches() -> Result<(), String> {
        let err = match next_employee_attendance_state(None, "CLOCK_OUT") {
            Ok(state) => return Err(format!("clock-out before clock-in returned {state}")),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(err.code, "invalid_transition");

        let err = match next_employee_attendance_state(Some("CLOCKED_IN"), "CLOCK_IN") {
            Ok(state) => return Err(format!("duplicate clock-in returned {state}")),
            Err(err) => err,
        };
        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(err.code, "invalid_transition");
        Ok(())
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn attendance_input_normalization_bounds_mobile_retry_fields() {
        let kind = normalize_attendance_kind(" business_trip ")
            .map_err(|err| err.message)
            .unwrap_or("invalid");
        assert_eq!(kind, "BUSINESS_TRIP");

        let idempotency_key = normalize_idempotency_key(" retry-1 ".to_owned())
            .map_err(|err| err.message)
            .unwrap_or_default();
        assert_eq!(idempotency_key, "retry-1");
        assert!(
            normalize_idempotency_key("   ".to_owned()).is_err(),
            "blank idempotency keys must be rejected"
        );
        assert!(
            normalize_attendance_note(Some("x".repeat(501))).is_err(),
            "long attendance notes must be rejected before persistence"
        );
    }

    #[cfg(feature = "test-postgres")]
    fn sample_settlement_input() -> ExitSettlementInput {
        ExitSettlementInput {
            average_wage_period_start: "2026-04-01".to_owned(),
            average_wage_period_end: "2026-06-30".to_owned(),
            average_wage_calendar_days: 91,
            average_wage_total_won: 9_000_000,
            monthly_ordinary_wage_won: 3_000_000,
        }
    }

    #[cfg(feature = "test-postgres")]
    async fn arm_console_rt(
        tx: &mut sqlx::Transaction<'_, Postgres>,
        org_id: Uuid,
    ) -> Result<(), String> {
        sqlx::query("SET LOCAL ROLE console_rt")
            .execute(tx.as_mut())
            .await
            .map_err(|err| format!("set runtime role failed: {err}"))?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(tx.as_mut())
            .await
            .map_err(|err| format!("arm current org failed: {err}"))?;
        Ok(())
    }

    #[cfg(feature = "test-postgres")]
    async fn seed_exit_case(pool: &sqlx::PgPool) -> Result<(Uuid, Uuid), String> {
        let org_id = Uuid::new_v4();
        let region_id = Uuid::new_v4();
        let branch_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        let employee_id = Uuid::new_v4();
        let case_id = Uuid::new_v4();
        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(format!("exit-{}", &org_id.to_string()[..8]))
            .bind("Exit Settlement Test")
            .execute(pool)
            .await
            .map_err(|err| format!("seed organization failed: {err}"))?;
        sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
            .bind(region_id)
            .bind("정산지역")
            .bind(org_id)
            .execute(pool)
            .await
            .map_err(|err| format!("seed region failed: {err}"))?;
        sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
            .bind(branch_id)
            .bind(region_id)
            .bind("본사")
            .bind(org_id)
            .execute(pool)
            .await
            .map_err(|err| format!("seed branch failed: {err}"))?;
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, $2, ARRAY['ADMIN']::TEXT[], true, $3)",
        )
        .bind(user_id)
        .bind("Exit HR Manager")
        .bind(org_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed user failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employees (
                id, org_id, company, name, employee_number, hire_date,
                source_filename, source_sheet, source_row, source_key, raw_row, source_metadata
            )
            VALUES ($1, $2, '테스트', '홍길동', 'E-001', '2020-01-01',
                    'employees.xlsx', '직원', 2, 'employee-row-2', '{}', '{}')
            "#,
        )
        .bind(employee_id)
        .bind(org_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed employee failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employee_exit_cases (
                id, org_id, employee_id, branch_id, status,
                effective_exit_date, site_manager_note, reported_by
            )
            VALUES ($1, $2, $3, $4, 'HR_CONFIRMED', '2026-06-30', '무단결근 확인', $5)
            "#,
        )
        .bind(case_id)
        .bind(org_id)
        .bind(employee_id)
        .bind(branch_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed exit case failed: {err}"))?;
        Ok((org_id, case_id))
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn certified_package_digest_is_deterministic_and_canonical() {
        let statutory = json!({"formula": "avg*30*days/365", "authority": "MOEL"});
        let insurance = json!({"forms": ["np", "hi"]});
        let approval = json!({"document_type": "employee_exit_settlement"});
        let digest = |severance: Option<i64>, basis: &Value| {
            compute_certified_package_digest(
                severance,
                basis,
                &insurance,
                &approval,
                Some("2026-04-01"),
                Some("2026-06-30"),
                Some(91),
                Some(9_000_000),
                Some(98_901),
                Some(2373),
                Some(3_000_000),
                Some(114_832),
                Some(98_901),
            )
        };
        let d1 = digest(Some(30_000_000), &statutory);
        let d2 = digest(Some(30_000_000), &statutory);
        assert_eq!(d1, d2, "identical inputs must hash identically");
        assert_eq!(d1.len(), 64, "digest is a 64-hex SHA-256");
        assert!(
            d1.chars().all(|c| c.is_ascii_hexdigit()),
            "digest must be lowercase hex"
        );

        let changed = digest(Some(30_000_001), &statutory);
        assert_ne!(
            d1, changed,
            "a changed severance figure must change the digest"
        );

        // Embedded-JSON key order must not affect the digest (canonical form).
        let mut reordered = serde_json::Map::new();
        reordered.insert("authority".to_owned(), json!("MOEL"));
        reordered.insert("formula".to_owned(), json!("avg*30*days/365"));
        let reordered = Value::Object(reordered);
        assert_eq!(
            d1,
            digest(Some(30_000_000), &reordered),
            "key order in embedded JSON must not change the digest"
        );
    }

    /// 0093 review HIGH #2: the certified digest must bind the 통상임금 basis
    /// DIRECTLY, not merely transitively through `severance_pay_won`. Changing
    /// ONLY the monthly ordinary wage (holding severance and every other covered
    /// field byte-identical — the case where the average wage governs the floor)
    /// must still change the digest.
    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn certified_digest_binds_ordinary_wage_even_when_severance_unchanged() {
        let statutory = json!({"formula": "avg*30*days/365"});
        let insurance = json!({"forms": ["np", "hi"]});
        let approval = json!({"document_type": "employee_exit_settlement"});
        let digest = |monthly: Option<i64>| {
            compute_certified_package_digest(
                // Severance + every non-ordinary covered field held CONSTANT.
                Some(30_000_000),
                &statutory,
                &insurance,
                &approval,
                Some("2026-04-01"),
                Some("2026-06-30"),
                Some(91),
                Some(9_000_000),
                Some(98_901),
                Some(2373),
                monthly,
                Some(114_832),
                Some(98_901),
            )
        };
        assert_ne!(
            digest(Some(3_000_000)),
            digest(Some(3_100_000)),
            "changing the ordinary wage must change the digest even when severance is unchanged"
        );
    }

    /// 0093 review HIGH #3 (money bug): the 통상일급 derivation must multiply
    /// BEFORE dividing (`(monthly * 8) / 209`), never floor `monthly / 209` first.
    /// Flooring first understated the daily ordinary wage by up to 7 won/day and
    /// under-paid severance whenever the ordinary floor governed.
    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn ordinary_daily_wage_multiplies_before_dividing() -> Result<(), String> {
        // monthly % 209 != 0 and the remainder × 8 crosses 209, so the buggy
        // floor-first formula and the corrected formula actually diverge.
        let monthly = 3_000_100_i64;
        assert_ne!(
            monthly % MONTHLY_STANDARD_HOURS,
            0,
            "must exercise a remainder"
        );
        // Buggy floor-first: floor(3_000_100 / 209) * 8 = 14_354 * 8 = 114_832.
        let buggy_floor_first = monthly / MONTHLY_STANDARD_HOURS * DAILY_CONTRACTUAL_HOURS;
        assert_eq!(
            buggy_floor_first, 114_832,
            "buggy floor-first value for reference"
        );
        // Corrected multiply-before-divide: (3_000_100 * 8) / 209 = 114_836.
        let corrected = ordinary_daily_wage_won_from_monthly(monthly)
            .map_err(|err| format!("unexpected overflow: {}", err.message))?;
        assert_eq!(corrected, 114_836, "must be (monthly * 8) / 209");
        assert!(
            corrected > buggy_floor_first,
            "multiply-before-divide must not understate the daily wage (corrected {corrected} vs buggy {buggy_floor_first})"
        );
        Ok(())
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn settlement_recalculation_reverts_certification(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let (org_id, case_id) = seed_exit_case(&pool).await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin failed: {err}"))?;
        arm_console_rt(&mut tx, org_id).await?;

        // Build the settlement package via the real code path, as console_rt.
        let package_id = upsert_exit_settlement_package(
            &mut tx,
            org_id,
            case_id,
            Some(sample_settlement_input()),
        )
        .await
        .map_err(|err| format!("initial upsert failed: {err:?}"))?;

        // Simulate the (deferred) 노무사 recording action: mark CERTIFIED with a
        // valid artifact + digest as console_rt.
        let validation = ProfessionalValidation {
            reviewer_kind: ProfessionalReviewerKind::LaborAttorney,
            reviewed_on: time::macros::date!(2026 - 07 - 03),
            artifact_sha256: "a".repeat(64),
            reviewer_reference: "노무법인 검증 2026-1".to_owned(),
        };
        sqlx::query(
            r#"
            UPDATE employee_exit_settlement_packages
            SET certification_status = 'CERTIFIED',
                certification_artifact = $3,
                certified_package_digest = $4
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .bind(certification_artifact_json(&validation))
        .bind("b".repeat(64))
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("simulate certification failed: {err}"))?;

        // Recompute settlement fields via the normal code path.
        upsert_exit_settlement_package(&mut tx, org_id, case_id, Some(sample_settlement_input()))
            .await
            .map_err(|err| format!("recompute upsert failed: {err:?}"))?;

        let row = sqlx::query(
            r#"
            SELECT certification_status,
                   certification_artifact IS NULL AS artifact_null,
                   certified_package_digest IS NULL AS digest_null
            FROM employee_exit_settlement_packages
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .fetch_one(tx.as_mut())
        .await
        .map_err(|err| format!("reload package failed: {err}"))?;
        let status: String = row
            .try_get("certification_status")
            .map_err(|err| format!("read status failed: {err}"))?;
        let artifact_null: bool = row
            .try_get("artifact_null")
            .map_err(|err| format!("read artifact_null failed: {err}"))?;
        let digest_null: bool = row
            .try_get("digest_null")
            .map_err(|err| format!("read digest_null failed: {err}"))?;

        tx.rollback()
            .await
            .map_err(|err| format!("rollback failed: {err}"))?;

        assert_eq!(
            status, "UNCERTIFIED_DRAFT",
            "a settlement recompute must revert certification_status"
        );
        assert!(artifact_null, "recompute must clear certification_artifact");
        assert!(digest_null, "recompute must clear certified_package_digest");
        Ok(())
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn certification_honored_only_when_digest_binds_current_numbers(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let (org_id, case_id) = seed_exit_case(&pool).await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin failed: {err}"))?;
        arm_console_rt(&mut tx, org_id).await?;

        let package_id = upsert_exit_settlement_package(
            &mut tx,
            org_id,
            case_id,
            Some(sample_settlement_input()),
        )
        .await
        .map_err(|err| format!("upsert failed: {err:?}"))?;

        // Compute the digest that binds the CURRENT row and certify with it.
        let covered = sqlx::query(
            r#"
            SELECT severance_pay_won, statutory_basis, insurance_loss_payload, approval_payload,
                   average_wage_period_start::TEXT AS average_wage_period_start,
                   average_wage_period_end::TEXT AS average_wage_period_end,
                   average_wage_calendar_days, average_wage_total_won,
                   average_daily_wage_milliwon, service_days,
                   monthly_ordinary_wage_won, ordinary_daily_wage_won,
                   statutory_daily_wage_milliwon
            FROM employee_exit_settlement_packages
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .fetch_one(tx.as_mut())
        .await
        .map_err(|err| format!("load covered fields failed: {err}"))?;
        let severance_pay_won: Option<i64> = covered
            .try_get("severance_pay_won")
            .map_err(|err| format!("{err}"))?;
        let statutory_basis: Value = covered
            .try_get("statutory_basis")
            .map_err(|err| format!("{err}"))?;
        let insurance_loss_payload: Value = covered
            .try_get("insurance_loss_payload")
            .map_err(|err| format!("{err}"))?;
        let approval_payload: Value = covered
            .try_get("approval_payload")
            .map_err(|err| format!("{err}"))?;
        let period_start: Option<String> = covered
            .try_get("average_wage_period_start")
            .map_err(|err| format!("{err}"))?;
        let period_end: Option<String> = covered
            .try_get("average_wage_period_end")
            .map_err(|err| format!("{err}"))?;
        let calendar_days: Option<i32> = covered
            .try_get("average_wage_calendar_days")
            .map_err(|err| format!("{err}"))?;
        let total_won: Option<i64> = covered
            .try_get("average_wage_total_won")
            .map_err(|err| format!("{err}"))?;
        let daily_milliwon: Option<i64> = covered
            .try_get("average_daily_wage_milliwon")
            .map_err(|err| format!("{err}"))?;
        let service_days: Option<i32> = covered
            .try_get("service_days")
            .map_err(|err| format!("{err}"))?;
        let monthly_ordinary_wage_won: Option<i64> = covered
            .try_get("monthly_ordinary_wage_won")
            .map_err(|err| format!("{err}"))?;
        let ordinary_daily_wage_won: Option<i64> = covered
            .try_get("ordinary_daily_wage_won")
            .map_err(|err| format!("{err}"))?;
        let statutory_daily_wage_milliwon: Option<i64> = covered
            .try_get("statutory_daily_wage_milliwon")
            .map_err(|err| format!("{err}"))?;
        let matching_digest = compute_certified_package_digest(
            severance_pay_won,
            &statutory_basis,
            &insurance_loss_payload,
            &approval_payload,
            period_start.as_deref(),
            period_end.as_deref(),
            calendar_days,
            total_won,
            daily_milliwon,
            service_days,
            monthly_ordinary_wage_won,
            ordinary_daily_wage_won,
            statutory_daily_wage_milliwon,
        );
        let validation = ProfessionalValidation {
            reviewer_kind: ProfessionalReviewerKind::TaxAccountant,
            reviewed_on: time::macros::date!(2026 - 07 - 03),
            artifact_sha256: "c".repeat(64),
            reviewer_reference: "세무법인 검증 2026-2".to_owned(),
        };
        sqlx::query(
            r#"
            UPDATE employee_exit_settlement_packages
            SET certification_status = 'CERTIFIED',
                certification_artifact = $3,
                certified_package_digest = $4
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .bind(certification_artifact_json(&validation))
        .bind(&matching_digest)
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("certify with matching digest failed: {err}"))?;

        // Matching digest → the read path honors CERTIFIED.
        let honored = load_exit_case_by_id(&mut tx, org_id, case_id)
            .await
            .map_err(|err| format!("load case (matching) failed: {err:?}"))?;
        assert_eq!(
            honored
                .settlement_package
                .as_ref()
                .map(|p| p.certification_status.as_str()),
            Some("CERTIFIED"),
            "a digest that binds the current numbers must be honored"
        );

        // Interleave a recompute the DB CHECK cannot catch: change a covered field
        // WITHOUT resetting certification, leaving a stale-certified row.
        sqlx::query(
            r#"
            UPDATE employee_exit_settlement_packages
            SET severance_pay_won = severance_pay_won + 1
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("mutate covered field failed: {err}"))?;

        let stale = load_exit_case_by_id(&mut tx, org_id, case_id)
            .await
            .map_err(|err| format!("load case (stale) failed: {err:?}"))?;
        assert_eq!(
            stale
                .settlement_package
                .as_ref()
                .map(|p| p.certification_status.as_str()),
            Some("UNCERTIFIED_DRAFT"),
            "a stale digest must NOT be honored as certified even if the row says CERTIFIED"
        );

        tx.rollback()
            .await
            .map_err(|err| format!("rollback failed: {err}"))?;
        Ok(())
    }

    /// 0093 review HIGH #1: certification invalidation is a TABLE invariant, not
    /// an app convention. A DIRECT covered-field SQL UPDATE (as the real `console_rt`
    /// runtime role) on a CERTIFIED row must leave the STORED
    /// certification_status = UNCERTIFIED_DRAFT with artifact/digest cleared —
    /// proving migration 0094's `enforce_settlement_certification_reset()` BEFORE
    /// UPDATE trigger fires for ANY write path, not just the two app statements.
    /// This asserts the STORED row (not merely the read-path demotion).
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn direct_covered_field_update_resets_stored_certification(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let (org_id, case_id) = seed_exit_case(&pool).await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin failed: {err}"))?;
        arm_console_rt(&mut tx, org_id).await?;

        let package_id = upsert_exit_settlement_package(
            &mut tx,
            org_id,
            case_id,
            Some(sample_settlement_input()),
        )
        .await
        .map_err(|err| format!("upsert failed: {err:?}"))?;

        // Certify as console_rt: this UPDATE touches ONLY the three certification
        // columns (none certification-covered), so the trigger leaves it intact.
        let validation = ProfessionalValidation {
            reviewer_kind: ProfessionalReviewerKind::LaborAttorney,
            reviewed_on: time::macros::date!(2026 - 07 - 03),
            artifact_sha256: "a".repeat(64),
            reviewer_reference: "노무법인 검증 2026-9".to_owned(),
        };
        sqlx::query(
            r#"
            UPDATE employee_exit_settlement_packages
            SET certification_status = 'CERTIFIED',
                certification_artifact = $3,
                certified_package_digest = $4
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .bind(certification_artifact_json(&validation))
        .bind("b".repeat(64))
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("certify failed: {err}"))?;

        let before: String = sqlx::query_scalar(
            "SELECT certification_status FROM employee_exit_settlement_packages WHERE org_id = $1 AND id = $2",
        )
        .bind(org_id)
        .bind(package_id)
        .fetch_one(tx.as_mut())
        .await
        .map_err(|err| format!("read pre-update status failed: {err}"))?;
        assert_eq!(
            before, "CERTIFIED",
            "certification must persist before the covered write"
        );

        // DIRECT covered-field UPDATE that does NOT touch any certification column.
        sqlx::query(
            r#"
            UPDATE employee_exit_settlement_packages
            SET severance_pay_won = severance_pay_won + 1
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("direct covered-field update failed: {err}"))?;

        let row = sqlx::query(
            r#"
            SELECT certification_status,
                   certification_artifact IS NULL AS artifact_null,
                   certified_package_digest IS NULL AS digest_null
            FROM employee_exit_settlement_packages
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .fetch_one(tx.as_mut())
        .await
        .map_err(|err| format!("reload row failed: {err}"))?;
        let status: String = row
            .try_get("certification_status")
            .map_err(|err| format!("read status failed: {err}"))?;
        let artifact_null: bool = row
            .try_get("artifact_null")
            .map_err(|err| format!("read artifact_null failed: {err}"))?;
        let digest_null: bool = row
            .try_get("digest_null")
            .map_err(|err| format!("read digest_null failed: {err}"))?;

        tx.rollback()
            .await
            .map_err(|err| format!("rollback failed: {err}"))?;

        assert_eq!(
            status, "UNCERTIFIED_DRAFT",
            "the DB trigger must reset STORED certification on ANY covered-field UPDATE"
        );
        assert!(
            artifact_null,
            "trigger must clear the STORED certification_artifact"
        );
        assert!(
            digest_null,
            "trigger must clear the STORED certified_package_digest"
        );
        Ok(())
    }

    /// GUARD (0093 pre-mortem #4): a human must never be able to file an
    /// uncertified severance figure with MOEL/NHIS because a label was
    /// missing from one of the generated documents. This FAILS if either
    /// generated payload (insurance-loss or approval) omits the effective
    /// certification status while the package is UNCERTIFIED_DRAFT, and
    /// FAILS if either payload fails to flip to CERTIFIED once a matching
    /// digest is recorded — proving the marker derives from the single
    /// effective-status computation rather than being hand-placed per payload.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn generated_payloads_carry_the_uncertified_draft_marker(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let (org_id, case_id) = seed_exit_case(&pool).await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin failed: {err}"))?;
        arm_console_rt(&mut tx, org_id).await?;

        let package_id = upsert_exit_settlement_package(
            &mut tx,
            org_id,
            case_id,
            Some(sample_settlement_input()),
        )
        .await
        .map_err(|err| format!("upsert failed: {err:?}"))?;

        // Persist an approval_payload the way the approval-draft handler does,
        // so both generated payloads (not just insurance-loss) are covered.
        let context = load_exit_case_context(&mut tx, org_id, case_id, false)
            .await
            .map_err(|err| format!("load context failed: {err:?}"))?;
        let approval_payload = build_exit_approval_payload(&context, None);
        sqlx::query(
            r#"
            UPDATE employee_exit_settlement_packages
            SET approval_payload = $3
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .bind(&approval_payload)
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("persist approval payload failed: {err}"))?;

        let uncertified = load_exit_case_by_id(&mut tx, org_id, case_id)
            .await
            .map_err(|err| format!("load case (uncertified) failed: {err:?}"))?;
        let package = uncertified
            .settlement_package
            .as_ref()
            .ok_or("settlement package must exist after upsert")?;
        assert_eq!(package.certification_status, "UNCERTIFIED_DRAFT");
        assert_eq!(
            package.insurance_loss_payload.get("certification_status"),
            Some(&Value::String("UNCERTIFIED_DRAFT".to_owned())),
            "insurance-loss payload must carry the draft marker when uncertified"
        );
        assert_eq!(
            package.approval_payload.get("certification_status"),
            Some(&Value::String("UNCERTIFIED_DRAFT".to_owned())),
            "approval payload must carry the draft marker when uncertified"
        );

        // Certify with a digest that binds the CURRENT numbers and verify both
        // payloads flip to CERTIFIED too.
        let covered = sqlx::query(
            r#"
            SELECT severance_pay_won, statutory_basis, insurance_loss_payload, approval_payload,
                   average_wage_period_start::TEXT AS average_wage_period_start,
                   average_wage_period_end::TEXT AS average_wage_period_end,
                   average_wage_calendar_days, average_wage_total_won,
                   average_daily_wage_milliwon, service_days,
                   monthly_ordinary_wage_won, ordinary_daily_wage_won,
                   statutory_daily_wage_milliwon
            FROM employee_exit_settlement_packages
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .fetch_one(tx.as_mut())
        .await
        .map_err(|err| format!("load covered fields failed: {err}"))?;
        let severance_pay_won: Option<i64> = covered
            .try_get("severance_pay_won")
            .map_err(|err| format!("{err}"))?;
        let statutory_basis: Value = covered
            .try_get("statutory_basis")
            .map_err(|err| format!("{err}"))?;
        let insurance_loss_payload: Value = covered
            .try_get("insurance_loss_payload")
            .map_err(|err| format!("{err}"))?;
        let approval_payload: Value = covered
            .try_get("approval_payload")
            .map_err(|err| format!("{err}"))?;
        let period_start: Option<String> = covered
            .try_get("average_wage_period_start")
            .map_err(|err| format!("{err}"))?;
        let period_end: Option<String> = covered
            .try_get("average_wage_period_end")
            .map_err(|err| format!("{err}"))?;
        let calendar_days: Option<i32> = covered
            .try_get("average_wage_calendar_days")
            .map_err(|err| format!("{err}"))?;
        let total_won: Option<i64> = covered
            .try_get("average_wage_total_won")
            .map_err(|err| format!("{err}"))?;
        let daily_milliwon: Option<i64> = covered
            .try_get("average_daily_wage_milliwon")
            .map_err(|err| format!("{err}"))?;
        let service_days: Option<i32> = covered
            .try_get("service_days")
            .map_err(|err| format!("{err}"))?;
        let monthly_ordinary_wage_won: Option<i64> = covered
            .try_get("monthly_ordinary_wage_won")
            .map_err(|err| format!("{err}"))?;
        let ordinary_daily_wage_won: Option<i64> = covered
            .try_get("ordinary_daily_wage_won")
            .map_err(|err| format!("{err}"))?;
        let statutory_daily_wage_milliwon: Option<i64> = covered
            .try_get("statutory_daily_wage_milliwon")
            .map_err(|err| format!("{err}"))?;
        let matching_digest = compute_certified_package_digest(
            severance_pay_won,
            &statutory_basis,
            &insurance_loss_payload,
            &approval_payload,
            period_start.as_deref(),
            period_end.as_deref(),
            calendar_days,
            total_won,
            daily_milliwon,
            service_days,
            monthly_ordinary_wage_won,
            ordinary_daily_wage_won,
            statutory_daily_wage_milliwon,
        );
        let validation = ProfessionalValidation {
            reviewer_kind: ProfessionalReviewerKind::LaborAttorney,
            reviewed_on: time::macros::date!(2026 - 07 - 03),
            artifact_sha256: "d".repeat(64),
            reviewer_reference: "노무법인 검증 2026-3".to_owned(),
        };
        sqlx::query(
            r#"
            UPDATE employee_exit_settlement_packages
            SET certification_status = 'CERTIFIED',
                certification_artifact = $3,
                certified_package_digest = $4
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(package_id)
        .bind(certification_artifact_json(&validation))
        .bind(&matching_digest)
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("certify with matching digest failed: {err}"))?;

        let certified = load_exit_case_by_id(&mut tx, org_id, case_id)
            .await
            .map_err(|err| format!("load case (certified) failed: {err:?}"))?;
        let package = certified
            .settlement_package
            .as_ref()
            .ok_or("settlement package must exist after certification")?;
        assert_eq!(package.certification_status, "CERTIFIED");
        assert_eq!(
            package.insurance_loss_payload.get("certification_status"),
            Some(&Value::String("CERTIFIED".to_owned())),
            "insurance-loss payload must reflect CERTIFIED once the digest matches"
        );
        assert_eq!(
            package.approval_payload.get("certification_status"),
            Some(&Value::String("CERTIFIED".to_owned())),
            "approval payload must reflect CERTIFIED once the digest matches"
        );

        tx.rollback()
            .await
            .map_err(|err| format!("rollback failed: {err}"))?;
        Ok(())
    }

    #[cfg(feature = "test-postgres")]
    async fn seed_exit_confirmer(
        pool: &sqlx::PgPool,
        org_id: Uuid,
        role: &str,
    ) -> Result<Uuid, String> {
        let user_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, $2, ARRAY[$3]::TEXT[], true, $4)",
        )
        .bind(user_id)
        .bind(format!("Exit {role}"))
        .bind(role)
        .bind(org_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed confirmer failed: {err}"))?;
        Ok(user_id)
    }

    /// US-005 two-tier separation of duties, pure decision function: HQ
    /// confirmation is gated on stored state + a distinct actor, never the
    /// client `hq_confirmation` boolean alone.
    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn exit_confirmation_hq_tier_enforces_state_and_distinct_actor() -> Result<(), String> {
        let hr_actor = Uuid::new_v4();
        let hq_actor = Uuid::new_v4();

        let reject = |status: &str, hr_by: Option<Uuid>, actor: Uuid, label: &str| {
            match authorize_exit_confirmation_hq_tier(status, hr_by, actor) {
                Ok(()) => Err(format!("{label} should have been rejected")),
                Err(err) => Ok(err),
            }
        };

        // (a) the actor who recorded the HR confirmation cannot also HQ-confirm.
        let same_actor = reject("HR_CONFIRMED", Some(hr_actor), hr_actor, "same-actor HQ")?;
        assert_eq!(same_actor.status, StatusCode::FORBIDDEN);

        // (b) HQ confirmation attempted while the case is still REPORTED (no HR
        // confirmation yet) is rejected out of order.
        let out_of_order = reject("REPORTED", None, hq_actor, "HQ-before-HR")?;
        assert_eq!(out_of_order.code, "invalid_transition");

        // An HR_CONFIRMED status with no recorded confirmer is still refused.
        let missing_hr = reject(
            "HR_CONFIRMED",
            None,
            hq_actor,
            "HQ with no recorded HR confirmer",
        )?;
        assert_eq!(missing_hr.code, "invalid_transition");

        // (c) happy path: a DISTINCT HQ actor on an HR_CONFIRMED case is allowed.
        authorize_exit_confirmation_hq_tier("HR_CONFIRMED", Some(hr_actor), hq_actor)
            .map_err(|err| format!("distinct HQ actor was rejected: {}", err.message))?;
        Ok(())
    }

    /// US-005 per-endpoint capability matrix, checked as capabilities against a
    /// real case's branch as `console_rt`: a role lacking each new capability is
    /// rejected on the corresponding endpoint's gate.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn exit_endpoints_reject_roles_lacking_the_new_capabilities(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        use console_platform_authz::Role;

        let (org_id, case_id) = seed_exit_case(&pool).await?;
        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin failed: {err}"))?;
        arm_console_rt(&mut tx, org_id).await?;

        let context = load_exit_case_context(&mut tx, org_id, case_id, false)
            .await
            .map_err(|err| format!("load context failed: {err:?}"))?;
        let branch = context.branch_id;
        let branch_scope = branch.map_or_else(BranchScope::none, |b| {
            BranchScope::single(BranchId::from_uuid(b))
        });
        let scoped = |role: Role, scope: BranchScope| {
            Principal::new(UserId::new(), OrgId::one(), BTreeSet::from([role]), scope)
        };

        // MECHANIC holds none of the exit-workflow capabilities.
        let mechanic = scoped(Role::Mechanic, branch_scope.clone());
        for feature in [
            Feature::ExitCaseReport,
            Feature::ExitCaseHrConfirm,
            Feature::ExitCaseHqConfirm,
            Feature::ExitSettlementManage,
        ] {
            assert!(
                authorize_hr_scoped_write(&mechanic, feature, branch).is_err(),
                "MECHANIC must be rejected for {feature:?}"
            );
        }

        // Branch ADMIN holds report / HR-confirm / settlement, but NOT HQ-confirm.
        let admin = scoped(Role::Admin, branch_scope);
        for feature in [
            Feature::ExitCaseReport,
            Feature::ExitCaseHrConfirm,
            Feature::ExitSettlementManage,
        ] {
            authorize_hr_scoped_write(&admin, feature, branch)
                .map_err(|err| format!("ADMIN unexpectedly rejected for {feature:?}: {err:?}"))?;
        }
        assert!(
            authorize_hr_scoped_write(&admin, Feature::ExitCaseHqConfirm, branch).is_err(),
            "a branch ADMIN must NOT hold the HQ confirmation capability"
        );

        // Org-wide EXECUTIVE holds HQ-confirm, but NOT the HR-manager write tier.
        let executive = scoped(Role::Executive, BranchScope::All);
        authorize_hr_scoped_write(&executive, Feature::ExitCaseHqConfirm, branch)
            .map_err(|err| format!("EXECUTIVE unexpectedly rejected for HQ confirm: {err:?}"))?;
        for feature in [
            Feature::ExitCaseReport,
            Feature::ExitCaseHrConfirm,
            Feature::ExitSettlementManage,
        ] {
            assert!(
                authorize_hr_scoped_write(&executive, feature, branch).is_err(),
                "EXECUTIVE (read/oversight tier) must NOT hold {feature:?}"
            );
        }

        tx.rollback()
            .await
            .map_err(|err| format!("rollback failed: {err}"))?;
        Ok(())
    }

    /// US-005 two-tier enforcement against REAL stored state read as `console_rt`:
    /// the decision derives from the persisted status + `hr_confirmed_by`, not
    /// the client flag. Covers (a) same-actor HQ rejected, (b) out-of-order HQ
    /// (still REPORTED) rejected, (c) a distinct HQ actor allowed.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn exit_confirmation_two_tier_uses_stored_state_not_client_flag(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let (org_id, case_id) = seed_exit_case(&pool).await?;
        let hr_actor = seed_exit_confirmer(&pool, org_id, "ADMIN").await?;
        let hq_actor = seed_exit_confirmer(&pool, org_id, "EXECUTIVE").await?;

        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin failed: {err}"))?;
        arm_console_rt(&mut tx, org_id).await?;

        // Record the first-tier (HR) confirmation on the seeded HR_CONFIRMED case
        // as console_rt (proves the runtime role can write the case under RLS).
        sqlx::query(
            r#"
            UPDATE employee_exit_cases
            SET hr_confirmed_by = $3, hr_confirmed_at = now()
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(case_id)
        .bind(hr_actor)
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("record HR confirmer failed: {err}"))?;

        // Read the authoritative state back as console_rt (proves RLS + the new
        // hr_confirmed_by column read on the load path).
        let confirmed = load_exit_case_context(&mut tx, org_id, case_id, true)
            .await
            .map_err(|err| format!("load HR_CONFIRMED context failed: {err:?}"))?;
        assert_eq!(confirmed.status, "HR_CONFIRMED");
        assert_eq!(confirmed.hr_confirmed_by, Some(hr_actor));

        // (a) the HR confirmer cannot also HQ-confirm the same case.
        let same_actor = match authorize_exit_confirmation_hq_tier(
            &confirmed.status,
            confirmed.hr_confirmed_by,
            hr_actor,
        ) {
            Ok(()) => {
                return Err(
                    "the HR confirmer must not be able to HQ-confirm the same case".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(same_actor.status, StatusCode::FORBIDDEN);

        // (c) a distinct HQ actor may HQ-confirm the HR-confirmed case.
        authorize_exit_confirmation_hq_tier(&confirmed.status, confirmed.hr_confirmed_by, hq_actor)
            .map_err(|err| format!("distinct HQ actor was rejected: {}", err.message))?;

        // (b) reset the case to REPORTED with no HR confirmer and prove an HQ
        // attempt is rejected out of order.
        sqlx::query(
            r#"
            UPDATE employee_exit_cases
            SET status = 'REPORTED', hr_confirmed_by = NULL, hr_confirmed_at = NULL
            WHERE org_id = $1 AND id = $2
            "#,
        )
        .bind(org_id)
        .bind(case_id)
        .execute(tx.as_mut())
        .await
        .map_err(|err| format!("reset to REPORTED failed: {err}"))?;

        let reported = load_exit_case_context(&mut tx, org_id, case_id, true)
            .await
            .map_err(|err| format!("load REPORTED context failed: {err:?}"))?;
        assert_eq!(reported.status, "REPORTED");
        let out_of_order = match authorize_exit_confirmation_hq_tier(
            &reported.status,
            reported.hr_confirmed_by,
            hq_actor,
        ) {
            Ok(()) => {
                return Err(
                    "HQ confirmation before any HR confirmation must be rejected".to_owned(),
                );
            }
            Err(err) => err,
        };
        assert_eq!(out_of_order.code, "invalid_transition");

        tx.rollback()
            .await
            .map_err(|err| format!("rollback failed: {err}"))?;
        Ok(())
    }

    // ---------------------------------------------------------------------
    // US-006: tenant isolation, audit coverage, and materializer discipline.
    // ---------------------------------------------------------------------

    /// Begin a transaction already dropped to the `console_rt` runtime role with the
    /// org GUC armed — the ONLY correct way to exercise RLS here, since the test
    /// pool logs in as the superuser/BYPASSRLS migration role and `console_rt` is
    /// NOLOGIN (cannot be a login pool).
    #[cfg(feature = "test-postgres")]
    async fn armed_tx(
        pool: &sqlx::PgPool,
        org_id: Uuid,
    ) -> Result<sqlx::Transaction<'_, Postgres>, String> {
        let mut tx = pool
            .begin()
            .await
            .map_err(|err| format!("begin failed: {err}"))?;
        arm_console_rt(&mut tx, org_id).await?;
        Ok(tx)
    }

    /// Seed one fully-formed org (region + branch + ACTIVE employee + a user) as
    /// the superuser pool role. Returns `(org_id, branch_id, employee_id,
    /// user_id)`. Seeding deliberately bypasses RLS; the isolation checks run in
    /// a separate `console_rt` transaction.
    #[cfg(feature = "test-postgres")]
    async fn seed_g009_base(pool: &sqlx::PgPool) -> Result<(Uuid, Uuid, Uuid, Uuid), String> {
        let org_id = Uuid::new_v4();
        let region_id = Uuid::new_v4();
        let branch_id = Uuid::new_v4();
        let employee_id = Uuid::new_v4();
        let user_id = Uuid::new_v4();
        sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)")
            .bind(org_id)
            .bind(format!("g009-{}", &org_id.to_string()[..8]))
            .bind("G009 Isolation Test")
            .execute(pool)
            .await
            .map_err(|err| format!("seed organization failed: {err}"))?;
        sqlx::query("INSERT INTO regions (id, name, org_id) VALUES ($1, $2, $3)")
            .bind(region_id)
            .bind("이탈지역")
            .bind(org_id)
            .execute(pool)
            .await
            .map_err(|err| format!("seed region failed: {err}"))?;
        sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
            .bind(branch_id)
            .bind(region_id)
            .bind("본사")
            .bind(org_id)
            .execute(pool)
            .await
            .map_err(|err| format!("seed branch failed: {err}"))?;
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, is_active, org_id) VALUES ($1, $2, ARRAY['ADMIN']::TEXT[], true, $3)",
        )
        .bind(user_id)
        .bind("G009 Reporter")
        .bind(org_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed user failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employees (
                id, org_id, company, name, employee_number, hire_date,
                source_filename, source_sheet, source_row, source_key, raw_row, source_metadata
            )
            VALUES ($1, $2, '테스트', '홍길동', 'E-001', '2020-01-01',
                    'employees.xlsx', '직원', 2, 'employee-row-2', '{}', '{}')
            "#,
        )
        .bind(employee_id)
        .bind(org_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed employee failed: {err}"))?;
        let mut command = pool
            .begin()
            .await
            .map_err(|err| format!("begin home-branch fixture command failed: {err}"))?;
        sqlx::query("SET LOCAL ROLE console_leave_definer")
            .execute(command.as_mut())
            .await
            .map_err(|err| format!("set leave definer role failed: {err}"))?;
        sqlx::query("SELECT set_config('app.current_org', $1, true)")
            .bind(org_id.to_string())
            .execute(command.as_mut())
            .await
            .map_err(|err| format!("arm fixture org failed: {err}"))?;
        let updated =
            sqlx::query("UPDATE employees SET home_branch_id = $1 WHERE id = $2 AND org_id = $3")
                .bind(branch_id)
                .bind(employee_id)
                .bind(org_id)
                .execute(command.as_mut())
                .await
                .map_err(|err| format!("set fixture employee home branch failed: {err}"))?;
        if updated.rows_affected() != 1 {
            return Err(
                "fixture home-branch command did not update exactly one employee".to_owned(),
            );
        }
        command
            .commit()
            .await
            .map_err(|err| format!("commit home-branch fixture command failed: {err}"))?;
        Ok((org_id, branch_id, employee_id, user_id))
    }

    /// Seed one row into each of the three G009 tenant tables for `org_id`.
    /// Returns `(alert_id, case_id, package_id)`.
    #[cfg(feature = "test-postgres")]
    async fn seed_g009_rows(
        pool: &sqlx::PgPool,
        org_id: Uuid,
        branch_id: Uuid,
        employee_id: Uuid,
        user_id: Uuid,
    ) -> Result<(Uuid, Uuid, Uuid), String> {
        let alert_id = Uuid::new_v4();
        let case_id = Uuid::new_v4();
        let package_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO employee_absence_alerts (id, org_id, employee_id, branch_id, work_date)
            VALUES ($1, $2, $3, $4, '2026-07-01')
            "#,
        )
        .bind(alert_id)
        .bind(org_id)
        .bind(employee_id)
        .bind(branch_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed absence alert failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employee_exit_cases (
                id, org_id, employee_id, branch_id, status,
                effective_exit_date, site_manager_note, reported_by
            )
            VALUES ($1, $2, $3, $4, 'REPORTED', '2026-06-30', '무단결근 확인', $5)
            "#,
        )
        .bind(case_id)
        .bind(org_id)
        .bind(employee_id)
        .bind(branch_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed exit case failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO employee_exit_settlement_packages (id, org_id, exit_case_id, employee_id)
            VALUES ($1, $2, $3, $4)
            "#,
        )
        .bind(package_id)
        .bind(org_id)
        .bind(case_id)
        .bind(employee_id)
        .execute(pool)
        .await
        .map_err(|err| format!("seed settlement package failed: {err}"))?;
        Ok((alert_id, case_id, package_id))
    }

    /// Every G009 tenant table is invisible AND un-writable across orgs when
    /// queried as the real `console_rt` runtime role armed to a different tenant.
    /// Seeding runs as the superuser pool role; the assertions run strictly as
    /// `console_rt` (via `arm_console_rt`), so a broken `org_isolation` policy cannot be
    /// masked by BYPASSRLS.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn g009_tables_isolate_tenants_as_console_rt(pool: sqlx::PgPool) -> Result<(), String> {
        let (org_a, branch_a, emp_a, user_a) = seed_g009_base(&pool).await?;
        seed_g009_rows(&pool, org_a, branch_a, emp_a, user_a).await?;
        let (org_b, branch_b, emp_b, user_b) = seed_g009_base(&pool).await?;
        let (alert_b, case_b, pkg_b) =
            seed_g009_rows(&pool, org_b, branch_b, emp_b, user_b).await?;

        // Reads + filtered updates, as console_rt armed to org A.
        let mut tx = armed_tx(&pool, org_a).await?;
        for (table, b_id) in [
            ("employee_absence_alerts", alert_b),
            ("employee_exit_cases", case_b),
            ("employee_exit_settlement_packages", pkg_b),
        ] {
            // sqlx 0.9 only accepts `&'static str` in `query`; dynamic table
            // names go through QueryBuilder (the file's own idiom).
            let visible: i64 =
                QueryBuilder::<Postgres>::new(format!("SELECT COUNT(*) FROM {table}"))
                    .build_query_scalar()
                    .fetch_one(tx.as_mut())
                    .await
                    .map_err(|err| format!("{table}: count as console_rt failed: {err}"))?;
            assert_eq!(
                visible, 1,
                "{table}: org A must see only its own row under RLS"
            );

            let mut b_lookup =
                QueryBuilder::<Postgres>::new(format!("SELECT COUNT(*) FROM {table} WHERE id = "));
            b_lookup.push_bind(b_id);
            let b_visible: i64 = b_lookup
                .build_query_scalar()
                .fetch_one(tx.as_mut())
                .await
                .map_err(|err| format!("{table}: org B lookup failed: {err}"))?;
            assert_eq!(
                b_visible, 0,
                "{table}: an org B row must be invisible to org A"
            );

            let mut cross_org_update = QueryBuilder::<Postgres>::new(format!(
                "UPDATE {table} SET updated_at = now() WHERE id = "
            ));
            cross_org_update.push_bind(b_id);
            let updated = cross_org_update
                .build()
                .execute(tx.as_mut())
                .await
                .map_err(|err| format!("{table}: cross-org update failed: {err}"))?;
            assert_eq!(
                updated.rows_affected(),
                0,
                "{table}: org A must not update an org B row (RLS USING filters it out)"
            );
        }
        tx.rollback()
            .await
            .map_err(|err| format!("rollback failed: {err}"))?;

        // Cross-org INSERTs must be rejected by the RLS WITH CHECK. A failed
        // statement aborts its transaction, so each runs in its own armed tx.
        {
            let mut tx = armed_tx(&pool, org_a).await?;
            let res = sqlx::query(
                "INSERT INTO employee_absence_alerts (org_id, employee_id, branch_id, work_date) VALUES ($1, $2, $3, '2026-07-09')",
            )
            .bind(org_b)
            .bind(emp_b)
            .bind(branch_b)
            .execute(tx.as_mut())
            .await;
            assert!(
                res.is_err(),
                "org A (console_rt) must not INSERT an org B absence alert"
            );
            let _ = tx.rollback().await;
        }
        {
            let mut tx = armed_tx(&pool, org_a).await?;
            let res = sqlx::query(
                "INSERT INTO employee_exit_cases (org_id, employee_id, branch_id, status, effective_exit_date, site_manager_note, reported_by) VALUES ($1, $2, $3, 'REPORTED', '2026-06-30', 'x', $4)",
            )
            .bind(org_b)
            .bind(emp_b)
            .bind(branch_b)
            .bind(user_b)
            .execute(tx.as_mut())
            .await;
            assert!(
                res.is_err(),
                "org A (console_rt) must not INSERT an org B exit case"
            );
            let _ = tx.rollback().await;
        }
        {
            let mut tx = armed_tx(&pool, org_a).await?;
            let res = sqlx::query(
                "INSERT INTO employee_exit_settlement_packages (org_id, exit_case_id, employee_id) VALUES ($1, $2, $3)",
            )
            .bind(org_b)
            .bind(case_b)
            .bind(emp_b)
            .execute(tx.as_mut())
            .await;
            assert!(
                res.is_err(),
                "org A (console_rt) must not INSERT an org B settlement package"
            );
            let _ = tx.rollback().await;
        }
        Ok(())
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn exit_report_uses_durable_branch_evidence_and_fails_closed_without_it(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        use console_platform_authz::Role;

        let (org_id, home_branch_id, employee_id, actor_id) = seed_g009_base(&pool).await?;
        let region_id: Uuid = sqlx::query_scalar("SELECT region_id FROM branches WHERE id = $1")
            .bind(home_branch_id)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("load region failed: {err}"))?;
        let foreign_branch_id = Uuid::new_v4();
        sqlx::query("INSERT INTO branches (id, region_id, name, org_id) VALUES ($1, $2, $3, $4)")
            .bind(foreign_branch_id)
            .bind(region_id)
            .bind("타지점")
            .bind(org_id)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed foreign branch failed: {err}"))?;

        let org = OrgId::from_uuid(org_id);
        let state = HrState::new(pool.clone(), None);
        let principal = |scope| {
            Principal::new(
                UserId::from_uuid(actor_id),
                org,
                BTreeSet::from([Role::Admin]),
                scope,
            )
        };
        let request =
            |target_employee_id, branch_id, absence_alert_id| ReportEmployeeExitCaseRequest {
                employee_id: target_employee_id,
                branch_id,
                absence_alert_id,
                effective_exit_date: "2026-06-30".to_owned(),
                site_manager_note: "branch provenance test".to_owned(),
                exit_reason_code: Some("PERSONAL".into()),
            };

        let forged = report_employee_exit_case(
            State(state.clone()),
            Extension(principal(BranchScope::single(BranchId::from_uuid(
                foreign_branch_id,
            )))),
            test_idempotency_headers(),
            Json(request(employee_id, Some(foreign_branch_id), None)),
        )
        .await
        .expect_err("a client branch must not override the employee's home branch");
        assert_eq!(forged.0.status, StatusCode::NOT_FOUND);

        let home_scope = BranchScope::single(BranchId::from_uuid(home_branch_id));
        let other_employee_id = Uuid::new_v4();
        sqlx::query(
            r#"
            INSERT INTO employees (
                id, org_id, company, name, hire_date,
                source_filename, source_sheet, source_row, source_key, raw_row, source_metadata
            )
            VALUES ($1, $2, '테스트', '다른직원', '2020-01-01',
                    'other.xlsx', '직원', 2, $3, '{}', '{}')
            "#,
        )
        .bind(other_employee_id)
        .bind(org_id)
        .bind(format!("other-{other_employee_id}"))
        .execute(&pool)
        .await
        .map_err(|err| format!("seed other employee failed: {err}"))?;
        let other_alert_id: Uuid = sqlx::query_scalar(
            r#"
            INSERT INTO employee_absence_alerts (org_id, employee_id, branch_id, work_date)
            VALUES ($1, $2, $3, '2026-06-29')
            RETURNING id
            "#,
        )
        .bind(org_id)
        .bind(other_employee_id)
        .bind(home_branch_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("seed other alert failed: {err}"))?;
        let wrong_employee_alert = report_employee_exit_case(
            State(state.clone()),
            Extension(principal(home_scope.clone())),
            test_idempotency_headers(),
            Json(request(
                employee_id,
                Some(home_branch_id),
                Some(other_alert_id),
            )),
        )
        .await
        .expect_err("another employee's alert must not authorize an exit report");
        assert_eq!(wrong_employee_alert.0.status, StatusCode::NOT_FOUND);
        let other_alert_state: (String, Option<Uuid>) = sqlx::query_as(
            "SELECT status, linked_exit_case_id FROM employee_absence_alerts WHERE id = $1",
        )
        .bind(other_alert_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("read other alert failed: {err}"))?;
        assert_eq!(other_alert_state, ("OPEN".to_owned(), None));

        let missing_alert = report_employee_exit_case(
            State(state.clone()),
            Extension(principal(home_scope.clone())),
            test_idempotency_headers(),
            Json(request(
                employee_id,
                Some(home_branch_id),
                Some(Uuid::new_v4()),
            )),
        )
        .await
        .expect_err("a nonexistent alert must not silently fall through");
        assert_eq!(missing_alert.0.status, StatusCode::NOT_FOUND);

        let branchless = report_employee_exit_case(
            State(state.clone()),
            Extension(principal(home_scope)),
            test_idempotency_headers(),
            Json(request(other_employee_id, None, None)),
        )
        .await
        .expect_err("a branch-scoped ADMIN must not mutate a branchless employee");
        assert_eq!(branchless.0.status, StatusCode::FORBIDDEN);

        for failed_employee_id in [employee_id, other_employee_id] {
            let leaked_cases: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM employee_exit_cases WHERE employee_id = $1",
            )
            .bind(failed_employee_id)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("count leaked cases failed: {err}"))?;
            let leaked_audits: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM audit_events WHERE action = 'employee.exit.report' AND target_id = $1",
            )
            .bind(failed_employee_id.to_string())
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("count leaked audits failed: {err}"))?;
            assert_eq!(leaked_cases, 0);
            assert_eq!(leaked_audits, 0);
        }

        let super_admin = Principal::new(
            UserId::from_uuid(actor_id),
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let created = report_employee_exit_case(
            State(state),
            Extension(super_admin),
            test_idempotency_headers(),
            Json(request(other_employee_id, None, None)),
        )
        .await
        .map_err(|err| format!("org-wide branchless report was rejected: {err:?}"))?;
        assert_eq!(created.0, StatusCode::CREATED);
        assert_eq!(created.1.0["branch_id"], Value::Null);
        Ok(())
    }

    /// Every G009 state-mutation handler routes its write through `with_audit`,
    /// so an `audit_events` row lands for the exit report, HR confirmation, HQ
    /// confirmation, and approval draft + submission. The settlement upsert is a
    /// side effect INSIDE the confirm/approval-draft audited transaction (there
    /// is no standalone settlement endpoint), so those events cover it, and the
    /// certification-bearing approval-draft event captures the resulting
    /// certification state. This drives the real handlers through the test pool
    /// role (audit emission is role-independent); the RLS proof is the dedicated
    /// `console_rt` test above.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn exit_workflow_handlers_emit_audit_events(pool: sqlx::PgPool) -> Result<(), String> {
        use console_platform_authz::Role;

        let (org_id, branch_id, employee_id, hr_user) = seed_g009_base(&pool).await?;
        let hq_user = seed_exit_confirmer(&pool, org_id, "EXECUTIVE").await?;
        let org = OrgId::from_uuid(org_id);
        let state = HrState::new(pool.clone(), None);

        let hr_principal = Principal::new(
            UserId::from_uuid(hr_user),
            org,
            BTreeSet::from([Role::Admin]),
            BranchScope::single(BranchId::from_uuid(branch_id)),
        );
        let hq_principal = Principal::new(
            UserId::from_uuid(hq_user),
            org,
            BTreeSet::from([Role::Executive]),
            BranchScope::All,
        );

        // (1) site-manager exit report.
        let reported = report_employee_exit_case(
            State(state.clone()),
            Extension(hr_principal.clone()),
            test_idempotency_headers(),
            Json(ReportEmployeeExitCaseRequest {
                employee_id,
                branch_id: Some(branch_id),
                absence_alert_id: None,
                effective_exit_date: "2026-06-30".to_owned(),
                site_manager_note: "무단결근 3일 — 이탈 보고".to_owned(),
                exit_reason_code: Some("PERSONAL".into()),
            }),
        )
        .await
        .map_err(|err| format!("report failed: {err:?}"))?;
        assert_eq!(reported.0, StatusCode::CREATED);
        let case_id: Uuid = serde_json::from_value(reported.1.0["id"].clone()).unwrap();

        // (2) HR confirmation (no wage source yet, so the case stays HR_CONFIRMED
        // for the HQ tier rather than being bumped to SETTLEMENT_READY).
        let _ = confirm_employee_exit_case(
            State(state.clone()),
            Extension(hr_principal.clone()),
            Path(case_id),
            Json(ConfirmEmployeeExitCaseRequest {
                exit_reason_code: None,
                dismissal_notice: None,
                hq_confirmation: false,
                note: None,
                settlement_input: None,
                step_up: None,
                signoffs: EmployeeLifecycleSignoffs {
                    privacy_notice_ack: true,
                    korean_labor_law_ack: true,
                    payroll_cutoff_ack: true,
                    retirement_settlement_ack: true,
                },
            }),
        )
        .await
        .map_err(|err| format!("HR confirm failed: {err:?}"))?;

        // (3) HQ confirmation by a DISTINCT actor.
        let _ = confirm_employee_exit_case(
            State(state.clone()),
            Extension(hq_principal.clone()),
            Path(case_id),
            Json(ConfirmEmployeeExitCaseRequest {
                exit_reason_code: None,
                dismissal_notice: None,
                hq_confirmation: true,
                note: None,
                settlement_input: None,
                step_up: None,
                signoffs: EmployeeLifecycleSignoffs::default(),
            }),
        )
        .await
        .map_err(|err| format!("HQ confirm failed: {err:?}"))?;

        // (4) approval draft — the wage source arrives here and the severance is
        // computed, then (5) submission of the same ready package.
        let _ = draft_employee_exit_approval(
            State(state.clone()),
            Extension(hr_principal.clone()),
            Path(case_id),
            Json(DraftEmployeeExitApprovalRequest {
                submit: false,
                note: None,
                settlement_input: Some(sample_settlement_input()),
            }),
        )
        .await
        .map_err(|err| format!("approval draft failed: {err:?}"))?;
        let _ = draft_employee_exit_approval(
            State(state.clone()),
            Extension(hr_principal.clone()),
            Path(case_id),
            Json(DraftEmployeeExitApprovalRequest {
                submit: true,
                note: None,
                settlement_input: None,
            }),
        )
        .await
        .map_err(|err| format!("approval submission failed: {err:?}"))?;

        let report_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.exit.report'",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count report audit failed: {err}"))?;
        assert_eq!(report_events, 1, "exit report must write one audit event");

        let hr_confirm_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.exit.confirm' AND actor = $2",
        )
        .bind(org_id)
        .bind(hr_user)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count HR confirm audit failed: {err}"))?;
        assert_eq!(
            hr_confirm_events, 1,
            "HR confirmation must write one audit event for the HR actor"
        );

        let hq_confirm_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.exit.confirm' AND actor = $2",
        )
        .bind(org_id)
        .bind(hq_user)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count HQ confirm audit failed: {err}"))?;
        assert_eq!(
            hq_confirm_events, 1,
            "HQ confirmation must write one audit event for the distinct HQ actor"
        );

        let draft_events: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.exit.approval_draft'",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("count approval draft audit failed: {err}"))?;
        assert_eq!(
            draft_events, 2,
            "approval draft + submission must each write an audit event"
        );

        // Certification-bearing path: the approval-draft audit captures the
        // certification state of the figure being drafted/submitted.
        let cert_state: Option<String> = sqlx::query_scalar(
            "SELECT after_snap->>'certification_status' FROM audit_events WHERE org_id = $1 AND action = 'employee.exit.approval_draft' LIMIT 1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("read approval-draft snapshot failed: {err}"))?;
        assert_eq!(
            cert_state.as_deref(),
            Some("UNCERTIFIED_DRAFT"),
            "the approval-draft audit must record the certification state of the drafted figure"
        );

        // The settlement upsert (side effect of the audited confirm/draft
        // transactions) persisted an uncertified package for this case.
        let pkg_cert: String = sqlx::query_scalar(
            "SELECT certification_status FROM employee_exit_settlement_packages WHERE org_id = $1 AND exit_case_id = $2",
        )
        .bind(org_id)
        .bind(case_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("read settlement certification failed: {err}"))?;
        assert_eq!(pkg_cert, "UNCERTIFIED_DRAFT");
        Ok(())
    }

    /// The dashboard-path absence-alert materializer is idempotent AND
    /// write-bounded. Run twice over the SAME imported attendance facts (as
    /// `console_rt`): the second pass creates no duplicate alert (UNIQUE(org_id,
    /// employee_id, work_date, source)) AND rewrites no existing row (the
    /// IS DISTINCT FROM guard on the ON CONFLICT UPDATE), proving a repeated
    /// dashboard GET cannot write-storm.
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn absence_alert_materializer_is_idempotent_and_write_bounded(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        let (org_id, branch_id, employee_id, _user_id) = seed_g009_base(&pool).await?;
        let run_id = Uuid::new_v4();
        let source_sha256 = "a".repeat(64);
        sqlx::query(
            r#"
            INSERT INTO data_import_runs (
                id, org_id, entity_type, status, source_filename, source_format,
                source_sha256, mapping_profile, input_rows, candidate_rows, preserved_rows,
                pay_period_start, pay_period_end
            )
            VALUES ($1, $2, 'attendance_direct', 'DRY_RUN', 'attendance.csv', 'csv', $3, '{}', 2, 2, 0, DATE '2026-06-01', DATE '2026-06-30')
            "#,
        )
        .bind(run_id)
        .bind(org_id)
        .bind(&source_sha256)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed import run failed: {err}"))?;
        for (idx, work_date) in ["2026-07-01", "2026-07-02"].into_iter().enumerate() {
            let import_row_id = Uuid::new_v4();
            let source_key = format!("sheet:CSV|row:{}", idx + 2);
            sqlx::query(
                r#"
                INSERT INTO data_import_rows (
                    id, org_id, run_id, source_sheet, source_row, source_key,
                    row_status, raw_row, canonical_row, validation
                )
                VALUES ($1, $2, $3, 'CSV', $4, $5, 'CANDIDATE', '{}', '{}',
                        '{"status":"ok","errors":[],"warnings":[]}')
                "#,
            )
            .bind(import_row_id)
            .bind(org_id)
            .bind(run_id)
            .bind(idx as i32 + 2)
            .bind(&source_key)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed import row failed: {err}"))?;
            sqlx::query(
                r#"
                INSERT INTO attendance_direct_import_events (
                    org_id, run_id, import_row_id, employee_id, branch_id,
                    source_sheet, source_row, source_key, source_sha256, fact_key,
                    employee_name, branch_name, work_date,
                    check_in_at, check_out_at, minutes_worked
                )
                VALUES ($1, $2, $3, $4, $5, 'CSV', $6, $7, $8, $9,
                        '홍길동', '본사', $10, NULL, NULL, 0)
                "#,
            )
            .bind(org_id)
            .bind(run_id)
            .bind(import_row_id)
            .bind(employee_id)
            .bind(branch_id)
            .bind(idx as i32 + 2)
            .bind(&source_key)
            .bind(&source_sha256)
            .bind(format!("fact-{idx}-{work_date}"))
            .bind(work_date)
            .execute(&pool)
            .await
            .map_err(|err| format!("seed attendance event failed: {err}"))?;
        }

        let fingerprint = |pool: sqlx::PgPool, org: Uuid| async move {
            sqlx::query_scalar::<_, String>(
                "SELECT COALESCE(string_agg(xmin::text, ',' ORDER BY id), '') FROM employee_absence_alerts WHERE org_id = $1",
            )
            .bind(org)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("fingerprint failed: {err}"))
        };

        // First materialization pass, as console_rt.
        {
            let mut tx = armed_tx(&pool, org_id).await?;
            materialize_absence_alerts_from_imports(&mut tx, org_id, &BranchScope::All)
                .await
                .map_err(|err| format!("first materialize failed: {err:?}"))?;
            tx.commit()
                .await
                .map_err(|err| format!("commit first pass failed: {err}"))?;
        }
        let count_first: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM employee_absence_alerts WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("count after first pass failed: {err}"))?;
        assert_eq!(count_first, 2, "one alert per absent work-date");
        let fingerprint_first = fingerprint(pool.clone(), org_id).await?;

        // Second pass over the identical facts, as console_rt.
        {
            let mut tx = armed_tx(&pool, org_id).await?;
            materialize_absence_alerts_from_imports(&mut tx, org_id, &BranchScope::All)
                .await
                .map_err(|err| format!("second materialize failed: {err:?}"))?;
            tx.commit()
                .await
                .map_err(|err| format!("commit second pass failed: {err}"))?;
        }
        let count_second: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM employee_absence_alerts WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .map_err(|err| format!("count after second pass failed: {err}"))?;
        assert_eq!(
            count_second, 2,
            "re-materializing the same facts must not create duplicate alerts"
        );
        let fingerprint_second = fingerprint(pool.clone(), org_id).await?;
        assert_eq!(
            fingerprint_first, fingerprint_second,
            "second materialization must rewrite no row (bounded write set — no write-storm)"
        );
        Ok(())
    }

    /// 0093 review MEDIUM #5: the dashboard-path materializer mutates the audited
    /// `employee_absence_alerts` table, so the FIRST (changed) dashboard read must
    /// emit an audit event that records the changed row count/ids + source facts.
    /// A SECOND read over unchanged imports must emit NO further event, so the
    /// idempotency / write-storm guard is preserved (audit real mutations only).
    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn dashboard_materializer_emits_audit_on_changed_facts(
        pool: sqlx::PgPool,
    ) -> Result<(), String> {
        use console_platform_authz::Role;

        let (org_id, branch_id, employee_id, user_id) = seed_g009_base(&pool).await?;

        // Seed one absent imported attendance fact so the first read materializes.
        let run_id = Uuid::new_v4();
        let source_sha256 = "a".repeat(64);
        sqlx::query(
            r#"
            INSERT INTO data_import_runs (
                id, org_id, entity_type, status, source_filename, source_format,
                source_sha256, mapping_profile, input_rows, candidate_rows, preserved_rows,
                pay_period_start, pay_period_end
            )
            VALUES ($1, $2, 'attendance_direct', 'DRY_RUN', 'attendance.csv', 'csv', $3, '{}', 1, 1, 0, DATE '2026-06-01', DATE '2026-06-30')
            "#,
        )
        .bind(run_id)
        .bind(org_id)
        .bind(&source_sha256)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed import run failed: {err}"))?;
        let import_row_id = Uuid::new_v4();
        let source_key = "sheet:CSV|row:2".to_owned();
        sqlx::query(
            r#"
            INSERT INTO data_import_rows (
                id, org_id, run_id, source_sheet, source_row, source_key,
                row_status, raw_row, canonical_row, validation
            )
            VALUES ($1, $2, $3, 'CSV', 2, $4, 'CANDIDATE', '{}', '{}',
                    '{"status":"ok","errors":[],"warnings":[]}')
            "#,
        )
        .bind(import_row_id)
        .bind(org_id)
        .bind(run_id)
        .bind(&source_key)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed import row failed: {err}"))?;
        sqlx::query(
            r#"
            INSERT INTO attendance_direct_import_events (
                org_id, run_id, import_row_id, employee_id, branch_id,
                source_sheet, source_row, source_key, source_sha256, fact_key,
                employee_name, branch_name, work_date,
                check_in_at, check_out_at, minutes_worked
            )
            VALUES ($1, $2, $3, $4, $5, 'CSV', 2, $6, $7, 'fact-1',
                    '홍길동', '본사', '2026-07-01', NULL, NULL, 0)
            "#,
        )
        .bind(org_id)
        .bind(run_id)
        .bind(import_row_id)
        .bind(employee_id)
        .bind(branch_id)
        .bind(&source_key)
        .bind(&source_sha256)
        .execute(&pool)
        .await
        .map_err(|err| format!("seed attendance event failed: {err}"))?;

        let org = OrgId::from_uuid(org_id);
        let state = HrState::new(pool.clone(), None);
        // Executive + org-wide scope: `authorize_org_wide` limits built-in
        // org-wide reads to SUPER_ADMIN/EXECUTIVE, so a branch-scoped ADMIN
        // cannot drive the org-wide dashboard read.
        let principal = Principal::new(
            UserId::from_uuid(user_id),
            org,
            BTreeSet::from([Role::Executive]),
            BranchScope::All,
        );
        let query = || AbsenceExitDashboardQuery {
            limit: None,
            offset: None,
            employee_id: None,
        };

        // First read: materializes one alert → one audit event.
        let _ = get_absence_exit_dashboard(
            State(state.clone()),
            Extension(principal.clone()),
            Query(query()),
        )
        .await
        .map_err(|err| format!("first dashboard read failed: {err:?}"))?;

        let (event_count, changed_count): (i64, Option<i64>) = {
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.absence_alert.materialize'",
            )
            .bind(org_id)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("count materialize audit failed: {err}"))?;
            let changed: Option<i64> = sqlx::query_scalar(
                "SELECT (after_snap->>'changed_count')::BIGINT FROM audit_events WHERE org_id = $1 AND action = 'employee.absence_alert.materialize' LIMIT 1",
            )
            .bind(org_id)
            .fetch_one(&pool)
            .await
            .map_err(|err| format!("read changed_count failed: {err}"))?;
            (count, changed)
        };
        assert_eq!(
            event_count, 1,
            "first materialization must emit exactly one audit event"
        );
        assert_eq!(
            changed_count,
            Some(1),
            "the audit event must record the changed row count"
        );

        // Second read over the identical facts: no change → no new audit event.
        let _ = get_absence_exit_dashboard(
            State(state.clone()),
            Extension(principal.clone()),
            Query(query()),
        )
        .await
        .map_err(|err| format!("second dashboard read failed: {err:?}"))?;

        let event_count_after_second: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.absence_alert.materialize'",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .map_err(|err| format!("recount materialize audit failed: {err}"))?;
        assert_eq!(
            event_count_after_second, 1,
            "an unchanged dashboard read must not emit a second audit event (write-storm guard preserved)"
        );
        Ok(())
    }

    #[cfg(feature = "test-postgres")]
    fn test_idempotency_headers() -> axum::http::HeaderMap {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(
            IDEMPOTENCY_KEY_HEADER,
            axum::http::HeaderValue::from_str(&format!("hr-unit-test-{}", Uuid::new_v4())).unwrap(),
        );
        headers
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn lifecycle_transition_refuses_onboard_and_transfer_when_already_exited() {
        let exited = EmployeeForLifecycle {
            company: "ACME".to_owned(),
            org_unit: None,
            org_unit_id: None,
            position: None,
            job_title_id: None,
            employment_status: "EXITED".to_owned(),
            employment_type: None,
            contract_start_date: None,
            contract_end_date: None,
            classification: Default::default(),
        };
        let base_signoffs = EmployeeLifecycleSignoffs {
            privacy_notice_ack: true,
            korean_labor_law_ack: true,
            ..EmployeeLifecycleSignoffs::default()
        };

        let onboard = NormalizedEmployeeLifecycleTransition {
            event_type: "ONBOARD".to_owned(),
            to_status: "ACTIVE".to_owned(),
            to_company: None,
            to_org_unit: None,
            to_org_unit_id: None,
            to_position: None,
            expected_return_date: None,
            contract_end_date: None,
            leave_type: None,
            to_job_title_id: None,
            reason_code: None,
            to_workplace_id: None,
            classify: Default::default(),
            effective_date: "2026-08-14".to_owned(),
            comment: "reinstate".to_owned(),
            signoffs: base_signoffs.clone(),
        };
        let onboard_err = validate_lifecycle_transition(&exited, &onboard).unwrap_err();
        assert_eq!(onboard_err.status, StatusCode::CONFLICT);
        assert_eq!(onboard_err.code, "invalid_transition");
        assert!(
            onboard_err.message.contains("EXITED"),
            "refusal must name the EXITED state, got: {}",
            onboard_err.message
        );

        let transfer = NormalizedEmployeeLifecycleTransition {
            event_type: "TRANSFER".to_owned(),
            to_status: "ACTIVE".to_owned(),
            to_company: Some("ACME-SUBSIDIARY".to_owned()),
            to_org_unit: None,
            to_org_unit_id: None,
            to_position: None,
            expected_return_date: None,
            contract_end_date: None,
            leave_type: None,
            to_job_title_id: None,
            reason_code: None,
            to_workplace_id: None,
            classify: Default::default(),
            effective_date: "2026-08-14".to_owned(),
            comment: "transfer".to_owned(),
            signoffs: base_signoffs,
        };
        let transfer_err = validate_lifecycle_transition(&exited, &transfer).unwrap_err();
        assert_eq!(transfer_err.status, StatusCode::CONFLICT);
        assert_eq!(transfer_err.code, "invalid_transition");
        assert!(
            transfer_err.message.contains("EXITED"),
            "refusal must name the EXITED state, got: {}",
            transfer_err.message
        );
    }

    #[cfg(not(feature = "test-postgres"))]
    #[test]
    fn allowed_events_follow_state_rules_and_noop_is_refused() {
        let events = |status: &str, employment_type: Option<&str>| -> Vec<&'static str> {
            allowed_lifecycle_events(status, employment_type)
                .into_iter()
                .map(|event| event.event_type)
                .collect()
        };
        assert_eq!(
            events("ACTIVE", Some("CONTRACT")),
            [
                "ONBOARD",
                "TRANSFER",
                "GROUP_TRANSFER",
                "PROMOTE",
                "APPOINT",
                "EMPLOYMENT_TYPE_CHANGE",
                "LEAVE_OF_ABSENCE",
                "CONTRACT_RENEWAL"
            ]
        );
        // MR-24/25: an APPOINT keeps the status; a 전환 needs the profile.
        assert_eq!(events("ON_LEAVE", None), ["APPOINT", "RETURN_FROM_LEAVE"]);
        assert_eq!(
            events("ON_LEAVE", Some("CONTRACT")),
            [
                "APPOINT",
                "EMPLOYMENT_TYPE_CHANGE",
                "RETURN_FROM_LEAVE",
                "CONTRACT_RENEWAL"
            ]
        );
        assert!(events("EXITED", Some("CONTRACT")).is_empty());

        let unit = Uuid::from_u128(7);
        let current = EmployeeForLifecycle {
            company: "ACME".to_owned(),
            org_unit: Some("정비1팀".to_owned()),
            org_unit_id: Some(unit),
            position: Some("대리".to_owned()),
            job_title_id: None,
            employment_status: "ACTIVE".to_owned(),
            employment_type: None,
            contract_start_date: None,
            contract_end_date: None,
            classification: Default::default(),
        };
        let transition = |event: &str| NormalizedEmployeeLifecycleTransition {
            event_type: event.to_owned(),
            to_status: "ACTIVE".to_owned(),
            to_company: None,
            to_org_unit: None,
            to_org_unit_id: None,
            to_position: None,
            expected_return_date: None,
            contract_end_date: None,
            leave_type: None,
            to_job_title_id: None,
            reason_code: None,
            to_workplace_id: None,
            classify: Default::default(),
            effective_date: "2026-08-14".to_owned(),
            comment: "noop".to_owned(),
            signoffs: EmployeeLifecycleSignoffs {
                privacy_notice_ack: true,
                korean_labor_law_ack: true,
                ..EmployeeLifecycleSignoffs::default()
            },
        };
        let code = |t: NormalizedEmployeeLifecycleTransition| {
            validate_lifecycle_transition(&current, &t)
                .err()
                .map(|e| e.code)
        };
        let mut same_unit = transition("TRANSFER");
        same_unit.to_org_unit_id = Some(unit);
        assert_eq!(code(same_unit), Some("lifecycle_noop"));
        assert_eq!(code(transition("TRANSFER")), Some("lifecycle_noop"));
        let mut other_unit = transition("TRANSFER");
        other_unit.to_org_unit_id = Some(Uuid::from_u128(8));
        assert_eq!(code(other_unit), None);
        let mut other_company = transition("TRANSFER");
        other_company.to_org_unit_id = Some(unit);
        other_company.to_company = Some("ACME-SUB".to_owned());
        // Not a no-op: a change of company is a 전적, never a TRANSFER (E-S3b).
        assert_eq!(
            code(other_company),
            Some("entity_change_needs_group_transfer")
        );
        let mut same_position = transition("PROMOTE");
        same_position.to_position = Some("대리".to_owned());
        assert_eq!(code(same_position), Some("lifecycle_noop"));
    }
}

#[cfg(test)]
#[path = "hr_unknown_fields.rs"]
mod unknown_fields_tests;

#[path = "hr_bodies.rs"]
mod hr_bodies;
use hr_bodies::*;

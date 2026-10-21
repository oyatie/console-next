//! 인사카드 section routes (MR-31/33/35): one employee's entries (create,
//! correct, void, history) and the per-section sheet (export, import preview,
//! import apply). Writes require an `Idempotency-Key` (a UUID); a replay
//! answers 200 with the stored result, a new write 201.

use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::routing::{get, post, put};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::record::{
    CreateRecordRequest, ImportReport, ImportSheetRequest, RecordEntryView, RecordHistory,
    RecordList, RecordPurpose, SectionSheet, UpdateRecordRequest, VoidRecordRequest,
};
use console_hr_adapter_postgres::{HrError, HrService};
use console_hr_domain::record::Section;
use console_platform_authz::Principal;
use serde::Deserialize;
use uuid::Uuid;

use crate::HrApiError;

pub const RECORDS_PATH: &str = "/api/v1/employees/{id}/records";
pub const RECORD_SECTION_PATH: &str = "/api/v1/employees/{id}/records/{section}";
pub const RECORD_ENTRY_PATH: &str = "/api/v1/employees/{id}/records/{section}/{entry_id}";
pub const RECORD_VOID_PATH: &str = "/api/v1/employees/{id}/records/{section}/{entry_id}/void";
pub const RECORD_HISTORY_PATH: &str = "/api/v1/employees/{id}/records/{section}/{entry_id}/history";
pub const RECORD_SHEET_PATH: &str = "/api/v1/employee-records/{section}";
pub const RECORD_IMPORT_PREVIEW_PATH: &str = "/api/v1/employee-records/{section}/import/preview";
pub const RECORD_IMPORT_APPLY_PATH: &str = "/api/v1/employee-records/{section}/import/apply";
pub const RECORD_ROUTE_PATHS: &[&str] = &[
    RECORDS_PATH,
    RECORD_SECTION_PATH,
    RECORD_ENTRY_PATH,
    RECORD_VOID_PATH,
    RECORD_HISTORY_PATH,
    RECORD_SHEET_PATH,
    RECORD_IMPORT_PREVIEW_PATH,
    RECORD_IMPORT_APPLY_PATH,
];

pub fn router(service: HrService) -> Router {
    Router::new()
        .route(RECORDS_PATH, get(list))
        .route(RECORD_SECTION_PATH, post(create))
        .route(RECORD_ENTRY_PATH, put(update))
        .route(RECORD_VOID_PATH, post(void))
        .route(RECORD_HISTORY_PATH, get(history))
        .route(RECORD_SHEET_PATH, get(sheet))
        .route(RECORD_IMPORT_PREVIEW_PATH, post(preview))
        .route(RECORD_IMPORT_APPLY_PATH, post(apply))
        .with_state(service)
}

fn idempotency_key(headers: &HeaderMap) -> Result<Uuid, HrApiError> {
    headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
        .ok_or_else(|| HrApiError(HrError::validation("Idempotency-Key header must be a UUID")))
}

fn section(segment: &str) -> Result<Section, HrApiError> {
    Ok(Section::from_segment(segment)?)
}

fn written<T>((body, created): (T, bool)) -> (StatusCode, Json<T>) {
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    (status, Json(body))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListQuery {
    section: Option<String>,
    #[serde(default)]
    include_voided: bool,
    /// Required for a restricted section (징계, 장애, 보훈): a
    /// `restricted_record_purpose` code, plus a note when the code asks.
    purpose: Option<String>,
    purpose_note: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PurposeQuery {
    purpose: Option<String>,
    purpose_note: Option<String>,
}

fn purpose(code: Option<String>, note: Option<String>) -> Option<RecordPurpose> {
    code.map(|code| RecordPurpose { code, note })
}

/// Record reads are never cached: a restricted one is 민감정보.
type NoStore<T> = ([(header::HeaderName, &'static str); 1], Json<T>);

fn no_store<T>(body: T) -> NoStore<T> {
    ([(header::CACHE_CONTROL, "no-store")], Json(body))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SheetQuery {
    after: Option<Uuid>,
    limit: Option<i64>,
}

async fn list(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(employee): Path<Uuid>,
    Query(query): Query<ListQuery>,
) -> Result<NoStore<RecordList>, HrApiError> {
    let section = query.section.as_deref().map(section).transpose()?;
    let purpose = purpose(query.purpose, query.purpose_note);
    Ok(no_store(
        service
            .employee_records(principal, employee, section, query.include_voided, purpose)
            .await?,
    ))
}

async fn create(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((employee, segment)): Path<(Uuid, String)>,
    headers: HeaderMap,
    Json(request): Json<CreateRecordRequest>,
) -> Result<(StatusCode, Json<RecordEntryView>), HrApiError> {
    let key = idempotency_key(&headers)?;
    let section = section(&segment)?;
    Ok(written(
        service
            .create_record(principal, employee, section, key, request)
            .await?,
    ))
}

async fn update(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((employee, segment, entry)): Path<(Uuid, String, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<UpdateRecordRequest>,
) -> Result<Json<RecordEntryView>, HrApiError> {
    let key = idempotency_key(&headers)?;
    let section = section(&segment)?;
    // A correction creates no resource: 200 whether written or replayed.
    let (view, _) = service
        .update_record(principal, employee, section, entry, key, request)
        .await?;
    Ok(Json(view))
}

async fn void(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((employee, segment, entry)): Path<(Uuid, String, Uuid)>,
    headers: HeaderMap,
    Json(request): Json<VoidRecordRequest>,
) -> Result<Json<RecordEntryView>, HrApiError> {
    let key = idempotency_key(&headers)?;
    let section = section(&segment)?;
    let (view, _) = service
        .void_record(principal, employee, section, entry, key, request)
        .await?;
    Ok(Json(view))
}

async fn history(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path((employee, segment, entry)): Path<(Uuid, String, Uuid)>,
    Query(query): Query<PurposeQuery>,
) -> Result<NoStore<RecordHistory>, HrApiError> {
    let section = section(&segment)?;
    let purpose = purpose(query.purpose, query.purpose_note);
    Ok(no_store(
        service
            .record_history(principal, employee, section, entry, purpose)
            .await?,
    ))
}

async fn sheet(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(segment): Path<String>,
    Query(query): Query<SheetQuery>,
) -> Result<Json<SectionSheet>, HrApiError> {
    let section = section(&segment)?;
    Ok(Json(
        service
            .record_section_sheet(principal, section, query.after, query.limit)
            .await?,
    ))
}

async fn preview(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(segment): Path<String>,
    Json(request): Json<ImportSheetRequest>,
) -> Result<Json<ImportReport>, HrApiError> {
    let section = section(&segment)?;
    Ok(Json(
        service
            .preview_record_import(principal, section, request)
            .await?,
    ))
}

async fn apply(
    State(service): State<HrService>,
    Extension(principal): Extension<Principal>,
    Path(segment): Path<String>,
    headers: HeaderMap,
    Json(request): Json<ImportSheetRequest>,
) -> Result<(StatusCode, Json<ImportReport>), HrApiError> {
    let key = idempotency_key(&headers)?;
    let section = section(&segment)?;
    Ok(written(
        service
            .apply_record_import(principal, section, key, request)
            .await?,
    ))
}

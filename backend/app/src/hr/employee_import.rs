//! The employee import handlers (`/api/v1/employees/import/…`), moved from
//! `hr.rs` with no behaviour change (BE-MIG foundation, backlog §4.2).

use axum::Json;
use axum::extract::{Extension, Multipart, Path, Query, State};
use axum::http::header::RETRY_AFTER;
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::import::apply_drive::Started;
use console_hr_adapter_postgres::import::apply_job::{ApplyJob, DriverSlot, RETRY_AFTER_SECS};
use console_hr_adapter_postgres::import::sheet::SheetContext;
use console_hr_adapter_postgres::import::types::{
    EmployeeImportApplyRequest, EmployeeImportDryRunSummary, EmployeeImportPreviewResponse,
    EmployeeImportReport, ImportDryRunRequest,
};
use console_hr_adapter_postgres::import::unplaced::{UnplacedPage, UnplacedQuery};
use console_hr_adapter_postgres::import::workbook::{mapping_request, parse_workbook};
use console_hr_rest::HrApiError;
use console_platform_authz::{Feature, Principal};
use uuid::Uuid;

use super::{
    HrState, authorize_hr_org_wide, read_xlsx_upload, require_leave_import_command_store,
    sha256_hex, workbook_read,
};

pub(super) async fn import_employees(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
) -> Result<Json<EmployeeImportReport>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    Err(state.hr.import_workbook_gone().into())
}

pub(super) async fn preview_employee_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    multipart: Multipart,
) -> Result<Json<EmployeeImportPreviewResponse>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let caps = state.hr.workbook_caps(principal.org_id).await?;
    let mut upload = read_xlsx_upload(multipart, caps.max_upload_bytes).await?;
    let source_sha256 = sha256_hex(&upload.bytes);
    // IMPORT-2: bounded read on a blocking thread, then any-layout detection.
    let bytes = std::mem::take(&mut upload.bytes);
    let sheets = workbook_read::read_workbook_blocking(bytes, caps).await?;
    let mapping = mapping_request(upload.mapping.as_deref())?;
    let memory = state.hr.import_column_memory(principal.org_id).await?;
    let context = SheetContext {
        filename: &upload.filename,
        org: *principal.org_id.as_uuid(),
        vault: state.rrn_vault.as_deref(),
    };
    let parsed = parse_workbook(&context, &sheets, &memory, &mapping)?;
    Ok(Json(
        state
            .hr
            .preview_import(principal, upload, source_sha256, parsed)
            .await?,
    ))
}

pub(super) async fn dry_run_employee_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    body: Option<Json<ImportDryRunRequest>>,
) -> Result<Json<EmployeeImportDryRunSummary>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    let request = body.map(|Json(b)| b).unwrap_or_default();
    Ok(Json(
        state.hr.dry_run_import(principal, run_id, request).await?,
    ))
}

/// How long an async apply is waited for before it answers 202 with its job.
/// a fixed grace, not a setting: it only decides the response
/// shape; the work is the same either way.
const APPLY_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// `POST …/apply`. With `Prefer: respond-async` (W11) every refusal is still
/// immediate, then 202 with the job (or 200 with the report of an applied
/// run); the job's progress reaches the shell as `import_run` events.
/// Without it the same job runs inline and the report comes back (200).
pub(super) async fn apply_employee_import(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
    headers: HeaderMap,
    Json(body): Json<EmployeeImportApplyRequest>,
) -> Response {
    let respond = async {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let command_store = require_leave_import_command_store(&state)?;
        if !prefers_async(&headers) {
            // r3:hire-02: the driver outlives the request. A request timeout
            // or a closed connection never stops an apply half way (the
            // roster half settled); the job finishes and GET …/apply reads it.
            let hr = state.hr.clone();
            let report = tokio::spawn(async move {
                hr.apply_import(principal, command_store, run_id, body)
                    .await
            })
            .await
            .map_err(|_| HrError::internal("the import apply task stopped"))??;
            return Ok(Json(report).into_response());
        }
        let slot = DriverSlot::take()?;
        let org = principal.org_id;
        Ok(match state.hr.start_apply(principal, run_id, body).await? {
            Started::Done(report) => Json(report).into_response(),
            Started::Running(job) => (StatusCode::ACCEPTED, Json(job)).into_response(),
            Started::Job(job) => {
                let hr = state.hr.clone();
                let driver = tokio::spawn(async move {
                    let _slot = slot;
                    let done = hr.drive_apply(Some(command_store), org, run_id).await;
                    if let Err(error) = &done {
                        tracing::info!(run = %run_id, code = error.code, "import apply job stopped");
                    }
                    done
                });
                // RFC 7240: a run that finishes within the grace answers its
                // report (200) and a failure its refusal; a longer one its job
                // (202), followed over the event stream. The driver goes on
                // either way (a dropped handle never stops it).
                match tokio::time::timeout(APPLY_GRACE, driver).await {
                    Ok(Ok(Ok(report))) => Json(report).into_response(),
                    Ok(Ok(Err(error))) => return Err(error),
                    _ => (StatusCode::ACCEPTED, Json(job)).into_response(),
                }
            }
        })
    };
    match respond.await {
        Ok(response) => response,
        Err(error) => refusal(error),
    }
}

/// `GET …/apply`: the run's apply job (read once after an `import_run` event
/// or on reconnect; never polled, decisions #27).
pub(super) async fn employee_import_apply_job(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Path(run_id): Path<Uuid>,
) -> Result<Json<ApplyJob>, HrApiError> {
    authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
    Ok(Json(state.hr.apply_job(principal.org_id, run_id).await?))
}

/// `GET /api/v1/employees/import/unplaced` (W03 / E8): the 미배치 queue,
/// counted and keyset-paged; `run_id` narrows it to one import's people.
pub(super) async fn list_import_unplaced(
    State(state): State<HrState>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<UnplacedQuery>,
) -> Result<Json<UnplacedPage>, HrApiError> {
    Ok(Json(state.hr.import_unplaced(principal, query).await?))
}

fn prefers_async(headers: &HeaderMap) -> bool {
    headers
        .get_all("prefer")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|p| p.trim().eq_ignore_ascii_case("respond-async"))
}

/// The error body, plus `Retry-After` on 503 `import_apply_busy` (#28).
fn refusal(error: HrError) -> Response {
    let busy = error.code == "import_apply_busy";
    let mut response = HrApiError::from(error).into_response();
    if busy {
        response
            .headers_mut()
            .insert(RETRY_AFTER, HeaderValue::from(RETRY_AFTER_SECS));
    }
    response
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue, StatusCode};
    use console_hr_adapter_postgres::HrError;

    use super::{prefers_async, refusal};

    #[test]
    fn only_a_respond_async_preference_starts_a_job() {
        let with = |value: &'static str| {
            let mut headers = HeaderMap::new();
            headers.insert("prefer", HeaderValue::from_static(value));
            prefers_async(&headers)
        };
        assert!(with("respond-async"));
        assert!(with("wait=10, Respond-Async"));
        assert!(!with("return=minimal"));
        assert!(!with("respond-asynchronously"));
        assert!(!prefers_async(&HeaderMap::new()));
    }

    /// #28: a shed apply says when to come back; any other refusal does not.
    #[test]
    fn a_busy_refusal_carries_retry_after_and_others_do_not() {
        let busy = refusal(HrError {
            status: StatusCode::SERVICE_UNAVAILABLE,
            code: "import_apply_busy",
            message: String::new(),
            refusals: None,
        });
        assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            busy.headers()
                .get("retry-after")
                .and_then(|v| v.to_str().ok()),
            Some("15")
        );
        let conflict = refusal(HrError {
            status: StatusCode::CONFLICT,
            code: "apply_in_progress",
            message: String::new(),
            refusals: None,
        });
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert!(conflict.headers().get("retry-after").is_none());
    }
}

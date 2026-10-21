//! Directory reads owned by PEOPLE-B: the roster facet counts and the CSV export.

use axum::Json;
use axum::body::Body;
use axum::extract::{Extension, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::directory::read_export::ExportPurposeQuery;
use console_hr_adapter_postgres::directory::read_facets::EmployeeFacets;
use console_hr_adapter_postgres::directory::read_filters::EmployeeListQuery;
use console_platform_authz::Principal;
use futures::StreamExt;

use crate::HrApiError;

/// `GET /api/v1/employees/facets`: the chip counts for the list filters
/// (`limit`/`offset` are ignored).
pub async fn employee_facets(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<EmployeeListQuery>,
) -> Result<Json<EmployeeFacets>, HrApiError> {
    Ok(Json(hr.employee_facets(principal, query).await?))
}

/// `GET /api/v1/employees/export.csv`: the filtered CSV with its 용도
/// (`export_purpose`) and `layout` (`standard`, or `register` for the
/// 근로자 명부 columns), streamed; the download is logged before the first
/// byte and never cached (INF-01, INF-02).
pub async fn export_employees_csv(
    State(hr): State<HrService>,
    Extension(principal): Extension<Principal>,
    Query(query): Query<EmployeeListQuery>,
    Query(purpose): Query<ExportPurposeQuery>,
) -> Result<Response, HrApiError> {
    let (file_name, chunks) = hr.export_employees_csv(principal, query, purpose).await?;
    let body = Body::from_stream(
        chunks.map(|chunk| chunk.map_err(|error| std::io::Error::other(error.message))),
    );
    let disposition = format!("attachment; filename=\"{file_name}\"");
    Ok((
        [
            (
                header::CACHE_CONTROL,
                HeaderValue::from_static("private, no-store"),
            ),
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/csv; charset=utf-8"),
            ),
            (
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&disposition).map_err(|_| {
                    console_hr_adapter_postgres::HrError::internal("invalid export file name")
                })?,
            ),
        ],
        body,
    )
        .into_response())
}

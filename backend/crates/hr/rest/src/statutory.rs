//! Statutory panel routes; all trust-boundary and authorization checks live in HR.
use crate::HrApiError;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_compliance_adapter_postgres::PgComplianceStore;
use console_hr_adapter_postgres::statutory::{
    FilingPage, FilingQuery, FilingTask, RecordFiling, RegisterExport, RegisterPage, RegisterQuery,
    RequestFiling,
};
use console_hr_adapter_postgres::{HrError, HrService};
use console_platform_authz::Principal;
use uuid::Uuid;

pub const FILINGS: &str = "/api/v1/statutory/insurance-filings";
pub const RECORD: &str = "/api/v1/statutory/insurance-filings/{event_id}/{kind}/{insurer}";
pub const REGISTER: &str = "/api/v1/statutory/worker-register";
pub const EXPORT: &str = "/api/v1/statutory/worker-register/export";
pub const WORKPLACES: &str = "/api/v1/statutory/workplaces";
pub const STATUTORY_ROUTE_PATHS: &[&str] = &[FILINGS, RECORD, REGISTER, EXPORT, WORKPLACES];
type StatutoryState = (HrService, PgComplianceStore);
pub fn router(service: HrService, compliance: PgComplianceStore) -> Router {
    Router::new()
        .route(FILINGS, get(filings).post(request))
        .route(RECORD, post(record))
        .route(REGISTER, get(register))
        .route(EXPORT, get(export))
        .route(WORKPLACES, get(workplaces))
        .with_state((service, compliance))
}
#[derive(serde::Deserialize)]
struct WorkplaceQuery {
    as_of: Option<String>,
}
async fn workplaces(
    State((hr, _)): State<StatutoryState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<WorkplaceQuery>,
) -> Result<Json<Vec<console_hr_adapter_postgres::statutory::RegisterWorkplace>>, HrApiError> {
    Ok(Json(hr.statutory_workplaces(p, q.as_of).await?))
}
async fn filings(
    State((hr, compliance)): State<StatutoryState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<FilingQuery>,
) -> Result<Json<FilingPage>, HrApiError> {
    let register = compliance
        .statutory_register()
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    Ok(Json(hr.insurance_filings(p, q, register).await?))
}
async fn register(
    State((hr, _)): State<StatutoryState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<RegisterQuery>,
) -> Result<Json<RegisterPage>, HrApiError> {
    Ok(Json(hr.worker_register(p, q).await?))
}
async fn record(
    State((hr, compliance)): State<StatutoryState>,
    Extension(p): Extension<Principal>,
    Path((id, kind, insurer)): Path<(Uuid, String, String)>,
    headers: HeaderMap,
    Json(body): Json<RecordFiling>,
) -> Result<Json<FilingTask>, HrApiError> {
    let key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| HrError::validation("Idempotency-Key is required"))?;
    let register = compliance
        .statutory_register()
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    Ok(Json(
        hr.record_insurance_filing(p, (id, kind, insurer), key.to_owned(), body, register)
            .await?,
    ))
}
async fn export(
    State((hr, _)): State<StatutoryState>,
    Extension(p): Extension<Principal>,
    Query(q): Query<RegisterQuery>,
    Query(o): Query<RegisterExport>,
) -> Result<Response, HrApiError> {
    let file = hr.export_worker_register(p, q, o).await?;
    Ok((
        [
            (header::CONTENT_TYPE, file.content_type.to_owned()),
            (header::CACHE_CONTROL, "private, no-store".to_owned()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", file.filename),
            ),
        ],
        file.bytes,
    )
        .into_response())
}

async fn request(
    State((hr, compliance)): State<StatutoryState>,
    Extension(p): Extension<Principal>,
    headers: HeaderMap,
    Json(body): Json<RequestFiling>,
) -> Result<Json<FilingPage>, HrApiError> {
    let key = headers
        .get("Idempotency-Key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| HrError::validation("Idempotency-Key is required"))?;
    let register = compliance
        .statutory_register()
        .await
        .map_err(|e| HrError::internal(e.to_string()))?;
    Ok(Json(
        hr.request_insurance_filing(p, key.to_owned(), body, register)
            .await?,
    ))
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::RequestFiling;
    use axum::Json;
    use axum::body::Body;
    use axum::extract::FromRequest;
    use axum::http::{Request, StatusCode, header};
    use axum::response::IntoResponse;

    async fn extract(kind: &str) -> Result<RequestFiling, StatusCode> {
        let body = serde_json::json!({
            "source_event_id": "00000000-0000-0000-0000-000000000001",
            "filing_kind": kind,
            "anchor_on": "2026-09-30",
        });
        let request = Request::post(super::FILINGS)
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body.to_string()))
            .expect("request");
        Json::<RequestFiling>::from_request(request, &())
            .await
            .map(|Json(body)| body)
            .map_err(|rejection| rejection.into_response().status())
    }

    /// The request route's own body extractor: a filing kind outside the published enum is a
    /// 422 at the boundary, before the handler reads or writes anything.
    #[tokio::test]
    async fn an_unknown_filing_kind_is_refused_422_before_the_handler() {
        assert_eq!(
            extract("AGE60").await.err(),
            Some(StatusCode::UNPROCESSABLE_ENTITY)
        );
        assert_eq!(
            extract("work_confirmation").await.err(),
            Some(StatusCode::UNPROCESSABLE_ENTITY)
        );
        for kind in [
            "WORK_CONFIRMATION",
            "SEPARATION_CERTIFICATE",
            "ACQUIRE_REQUESTED",
            "MONTHLY_REMUNERATION",
        ] {
            let parsed = extract(kind).await.expect(kind);
            assert_eq!(parsed.filing_kind.as_str(), kind);
        }
    }
}

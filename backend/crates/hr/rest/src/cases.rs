// SPDX-License-Identifier: LicenseRef-Proprietary
//! Lifecycle trail routes; HR owns authorization, evidence and state transitions.

use axum::extract::{Path, Query, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use console_hr_adapter_postgres::cases::{
    CompleteItem, LifecycleCase, TemplateItem, TemplatePreviewQuery,
};
use console_hr_adapter_postgres::{HrError, HrService};
use console_platform_authz::Principal;
use serde::Serialize;
use uuid::Uuid;

pub const EMPLOYEE_CASES: &str = "/api/v1/employees/{id}/lifecycle-cases";
pub const CASE: &str = "/api/v1/lifecycle-cases/{id}";
pub const ITEM: &str = "/api/v1/lifecycle-cases/{id}/items/{item_id}/complete";
pub const CLOSE: &str = "/api/v1/lifecycle-cases/{id}/close";
pub const PREVIEW: &str = "/api/v1/lifecycle-case-templates/{key}";
pub const LIFECYCLE_CASE_ROUTE_PATHS: &[&str] = &[EMPLOYEE_CASES, CASE, ITEM, CLOSE, PREVIEW];

#[derive(Clone)]
struct CaseState {
    hr: HrService,
    passkeys: Option<console_platform_auth::PasskeyService>,
}

pub fn router(hr: HrService) -> Router {
    router_with_passkeys(hr, None)
}

pub fn router_with_passkeys(
    hr: HrService,
    passkeys: Option<console_platform_auth::PasskeyService>,
) -> Router {
    Router::new()
        .route(EMPLOYEE_CASES, get(employee_cases))
        .route(CASE, get(case))
        .route(ITEM, post(complete))
        .route(CLOSE, post(close))
        .route(PREVIEW, get(preview))
        .with_state(CaseState { hr, passkeys })
}

#[derive(Debug)]
struct CaseApiError(HrError);

impl From<HrError> for CaseApiError {
    fn from(error: HrError) -> Self {
        Self(error)
    }
}

#[derive(Serialize)]
struct ProblemDetails {
    #[serde(rename = "type")]
    problem_type: &'static str,
    title: &'static str,
    status: u16,
    detail: String,
    code: &'static str,
    error: ProblemError,
}

#[derive(Serialize)]
struct ProblemError {
    code: &'static str,
    message: String,
}

impl IntoResponse for CaseApiError {
    fn into_response(self) -> Response {
        let Self(error) = self;
        let body = ProblemDetails {
            problem_type: "about:blank",
            title: error.code,
            status: error.status.as_u16(),
            detail: error.message.clone(),
            code: error.code,
            error: ProblemError {
                code: error.code,
                message: error.message,
            },
        };
        (
            error.status,
            [(header::CONTENT_TYPE, "application/problem+json")],
            Json(body),
        )
            .into_response()
    }
}

async fn employee_cases(
    State(CaseState { hr, .. }): State<CaseState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<Vec<LifecycleCase>>, CaseApiError> {
    Ok(Json(hr.employee_lifecycle_cases(p, id).await?))
}

async fn case(
    State(CaseState { hr, .. }): State<CaseState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<LifecycleCase>, CaseApiError> {
    Ok(Json(hr.lifecycle_case(p, id).await?))
}

async fn complete(
    State(CaseState { hr, passkeys }): State<CaseState>,
    Extension(p): Extension<Principal>,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<CompleteItem>,
) -> Result<Json<LifecycleCase>, CaseApiError> {
    Ok(Json(
        hr.complete_lifecycle_item_with_passkeys(p, id, item_id, body, passkeys.as_ref())
            .await?,
    ))
}

async fn close(
    State(CaseState { hr, .. }): State<CaseState>,
    Extension(p): Extension<Principal>,
    Path(id): Path<Uuid>,
) -> Result<Json<LifecycleCase>, CaseApiError> {
    Ok(Json(hr.close_lifecycle_case(p, id).await?))
}

async fn preview(
    State(CaseState { hr, .. }): State<CaseState>,
    Extension(p): Extension<Principal>,
    Path(key): Path<String>,
    Query(q): Query<TemplatePreviewQuery>,
) -> Result<Json<Vec<TemplateItem>>, CaseApiError> {
    Ok(Json(hr.lifecycle_template_preview_for(p, key, q).await?))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use console_kernel_core::KernelError;
    use serde_json::json;

    #[tokio::test]
    async fn lifecycle_refusal_preserves_its_code_in_problem_details() {
        let error = HrError::from_kernel(
            KernelError::validation("The filing window has not opened")
                .with_code("lifecycle.refuse.window_not_open"),
        );
        let response = CaseApiError::from(error).into_response();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/problem+json"
        );
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            body,
            json!({
                "type": "about:blank",
                "title": "lifecycle.refuse.window_not_open",
                "status": 422,
                "detail": "The filing window has not opened",
                "code": "lifecycle.refuse.window_not_open",
                "error": {"code":"lifecycle.refuse.window_not_open", "message":"The filing window has not opened"}
            })
        );
    }
}

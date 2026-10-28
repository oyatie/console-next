//! `{"error": {code, message, current_version?, errors?, details?}}` — the shared `ErrorBody`.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use console_platform_access::{AccessError, Refusal};
use serde_json::json;

pub(crate) struct ApiError(pub AccessError);

impl From<AccessError> for ApiError {
    fn from(err: AccessError) -> Self {
        Self(err)
    }
}

pub(crate) type ApiResult<T> = Result<T, ApiError>;

const fn status(kind: Refusal) -> StatusCode {
    match kind {
        Refusal::Invalid => StatusCode::UNPROCESSABLE_ENTITY,
        Refusal::NotFound => StatusCode::NOT_FOUND,
        Refusal::Forbidden => StatusCode::FORBIDDEN,
        Refusal::Conflict => StatusCode::CONFLICT,
        Refusal::StepUpRequired => StatusCode::PRECONDITION_REQUIRED,
        Refusal::StepUpFailed => StatusCode::UNAUTHORIZED,
        Refusal::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
        Refusal::Internal => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let e = self.0;
        let mut error = json!({ "code": e.code, "message": e.message });
        if let Some(id) = e.original_operation_id {
            error["original_operation_id"] = json!(id);
        }
        if let Some(v) = e.current_version {
            error["current_version"] = json!(v);
        }
        if let Some(field) = e.field {
            error["errors"] = json!([{ "field": field, "code": e.code }]);
        }
        if let Some(details) = e.details {
            error["details"] = *details;
        }
        (status(e.kind), Json(json!({ "error": error }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn incomplete_review_keeps_its_conflict_status_and_open_events() {
        let mut error = AccessError::from(console_kernel_core::KernelError::conflict("incomplete"));
        error.code = "review_incomplete";
        error.details = Some(Box::new(json!({"open_event_ids":[uuid::Uuid::nil()]})));
        let response = ApiError(error).into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "review_incomplete");
        assert_eq!(
            body["error"]["details"]["open_event_ids"],
            json!([uuid::Uuid::nil()])
        );
    }
}

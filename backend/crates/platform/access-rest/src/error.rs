//! `{"error": {code, message, current_version?, errors?}}` — the shared `ErrorBody`.

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
        (status(e.kind), Json(json!({ "error": error }))).into_response()
    }
}

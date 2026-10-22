//! The one `IntoResponse` for `HrError` (backend-module-map §1.4). The body
//! moved verbatim from `app/src/hr.rs`; `error_wire_pins` pins its bytes.

use axum::Json;
use axum::response::{IntoResponse, Response};
use console_hr_adapter_postgres::HrError;
use console_kernel_core::KernelError;
use serde_json::json;

/// `HrError` on the wire: `{"error": {"code", "message", "refusals"?, "errors"?}}`.
#[derive(Debug)]
pub struct HrApiError(pub HrError);

impl From<HrError> for HrApiError {
    fn from(error: HrError) -> Self {
        Self(error)
    }
}

/// Domain normalisers return `KernelError`; map it exactly as `HrError` does.
impl From<KernelError> for HrApiError {
    fn from(error: KernelError) -> Self {
        Self(HrError::from_kernel(error))
    }
}

impl IntoResponse for HrApiError {
    fn into_response(self) -> Response {
        let Self(this) = self;
        let mut error = json!({ "code": this.code, "message": this.message });
        if let Some(errors) = this.errors {
            error["errors"] = json!(errors);
        }
        if let Some(refusals) = this.refusals {
            error["refusals"] = *refusals;
        }
        (this.status, Json(json!({ "error": error }))).into_response()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::StatusCode;

    #[tokio::test]
    async fn hr_kernel_refusal_keeps_its_code_and_field() {
        let error = KernelError::validation("hire date must follow exit")
            .with_code("rehire_date_not_after_exit")
            .with_field("hire_date");
        let hr = HrError::from(error);
        let response = HrApiError::from(hr).into_response();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "rehire_date_not_after_exit");
        assert_eq!(
            body["error"]["errors"],
            json!([
                { "field": "hire_date", "code": "rehire_date_not_after_exit" }
            ])
        );
    }
}

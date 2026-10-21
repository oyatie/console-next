//! The one `IntoResponse` for `HrError` (backend-module-map §1.4). The body
//! moved verbatim from `app/src/hr.rs`; `error_wire_pins` pins its bytes.

use axum::Json;
use axum::response::{IntoResponse, Response};
use console_hr_adapter_postgres::HrError;
use console_kernel_core::KernelError;
use serde_json::json;

/// `HrError` on the wire: `{"error": {"code", "message", "refusals"?}}`.
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
        if let Some(refusals) = this.refusals {
            error["refusals"] = refusals;
        }
        (this.status, Json(json!({ "error": error }))).into_response()
    }
}

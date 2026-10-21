//! S2 read refusals and per-cell previews use the shared refusal audit; writes already have command middleware.
use crate::{AttendanceRestState, RestError};
use axum::extract::{Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use console_platform_authz::Principal;

pub(super) async fn record(
    state: &AttendanceRestState,
    principal: &Principal,
    code: &str,
) -> Result<(), RestError> {
    console_platform_request_context::record_refusal(state.store.pool(), principal, code, None)
        .await
        .map_err(|_| unavailable())
}

fn unavailable() -> RestError {
    RestError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "attendance refusal audit could not be recorded",
    )
}

pub(super) async fn read_refusal(
    State(state): State<AttendanceRestState>,
    request: Request,
    next: Next,
) -> Response {
    if request.method() != Method::GET {
        return next.run(request).await;
    }
    let principal = request.extensions().get::<Principal>().cloned();
    let response = next.run(request).await;
    if !response.status().is_client_error() {
        return response;
    }
    let Some(principal) = principal else {
        return unavailable().into_response();
    };
    let Some(code) = response
        .extensions()
        .get::<crate::error::RefusalCode>()
        .copied()
        .or_else(|| {
            (response.status() == StatusCode::BAD_REQUEST)
                .then_some(crate::error::RefusalCode("bad_request"))
        })
    else {
        return response;
    };
    if let Err(error) = record(&state, &principal, code.0).await {
        return error.into_response();
    }
    response
}

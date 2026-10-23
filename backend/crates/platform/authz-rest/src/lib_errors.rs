// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[tokio::test]
async fn kernel_stable_code_survives_the_rest_response() {
    let response = RestError::from_kernel(
        KernelError::validation("evaluation limit exceeded").with_code("policy_bulk_limit"),
    )
    .into_response();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    let bytes = axum::body::to_bytes(response.into_body(), 1024)
        .await
        .unwrap();
    let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(body["error"]["code"], "policy_bulk_limit");
}

#[test]
fn kernel_errors_without_a_stable_code_keep_the_kind_code() {
    for (kind, code) in [
        (ErrorKind::Validation, "validation"),
        (ErrorKind::NotFound, "not_found"),
        (ErrorKind::Forbidden, "forbidden"),
        (ErrorKind::Conflict, "conflict"),
        (ErrorKind::InvalidTransition, "invalid_transition"),
        (ErrorKind::Internal, "internal"),
    ] {
        assert_eq!(
            RestError::from_kernel(KernelError::new(kind, "test")).code(),
            code
        );
    }
}

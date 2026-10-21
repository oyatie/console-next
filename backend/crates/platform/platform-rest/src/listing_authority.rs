use crate::{PlatformError, PlatformRestState};
use axum::http::StatusCode;
use console_kernel_core::OrgId;
use console_platform_auth::AccessClaims;
use console_platform_authz::{PlatformPrincipal, cedar_pbac::actions::platform_listing};
use console_platform_request_context::{RequestContextError, validate_current_claims_in_tx};
use sqlx::{Postgres, Transaction};

pub(crate) fn storage_error(error: sqlx::Error) -> PlatformError {
    let error = console_platform_db::DbError::begin(error);
    tracing::error!(%error, "platform listing transaction failed");
    PlatformError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal",
        "internal server error",
    )
}

pub(crate) async fn begin(
    state: &PlatformRestState,
    principal: &PlatformPrincipal,
    claims: &AccessClaims,
    operation: &str,
    refusal: &'static str,
) -> Result<Transaction<'static, Postgres>, PlatformError> {
    let mut tx = state.pool.begin().await.map_err(storage_error)?;
    let (user, org) = validate_current_claims_in_tx(&mut tx, claims)
        .await
        .map_err(|error| match error {
            RequestContextError::InvalidToken | RequestContextError::InvalidClaim(_) => {
                PlatformError::new(StatusCode::UNAUTHORIZED, "unauthorized", error.to_string())
            }
            _ => {
                tracing::error!(%error, "platform listing authority failed");
                PlatformError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal",
                    "internal server error",
                )
            }
        })?;
    if user != principal.user_id || org != OrgId::platform() || !claims.platform {
        return Err(PlatformError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "invalid bearer token",
        ));
    }
    if claims.enrollment {
        return Err(PlatformError::forbidden(
            console_platform_request_context::PASSKEY_REQUIRED_MESSAGE,
        ));
    }
    let roles: Vec<_> = claims.roles.iter().map(String::as_str).collect();
    if !platform_listing::decide(&user.to_string(), &org.to_string(), &roles, true, operation) {
        return Err(PlatformError::forbidden(refusal));
    }
    Ok(tx)
}

#[cfg(test)]
mod tests {
    use super::storage_error;
    use axum::body::to_bytes;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use console_platform_db::watch_pool_timeouts;
    use serde_json::{Value, json};

    #[tokio::test]
    async fn listing_timeouts_mark_overload_without_disclosing_database_errors() {
        for (error, expected_timeout) in [
            (sqlx::Error::PoolTimedOut, true),
            (sqlx::Error::PoolClosed, false),
        ] {
            let (error, timed_out) = watch_pool_timeouts(async { storage_error(error) }).await;
            assert_eq!(timed_out, expected_timeout);
            // The app redactor uses the marker to turn only overload into 503.
            let response = error.into_response();
            assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
            let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
            let body: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(
                body,
                json!({"error": {"code": "internal", "message": "internal server error"}})
            );
        }
    }
}
